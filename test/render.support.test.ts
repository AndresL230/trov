/**
 * Render tests — the support form and where it is read (docs/architecture/support.md):
 *   • web/src/support.ts: the dialog (one, with a kind switch), what it says is attached, its sending /
 *     failed / sent states, and that its structure is stable while the form is up;
 *   • the ways in, signed in: the header's bug button, Settings › Contact support, the org picker's
 *     link — and nothing in the sidebar; signed out: the site footer's Contact and the anonymous form;
 *   • web/src/platform-support.ts: the Support tab (count on the tab, filters, table, skeleton, error,
 *     empty) and one report (message, attached context, mail outcome, Resolve / Reopen, Reply by email);
 *   • the route `#platform/support/<id>`.
 * Pure functions, mock-fed state, HTML-string assertions (pattern: render.platform.test.ts).
 */
import { describe, it, expect } from "vitest";
import css from "../web/src/trov.css?raw";
import {
  initialSupport, supportDialog, supportAttached, supportProblem, supportSentSentence, supportCounter, SUPPORT_COPY, SUPPORT_ENTRIES,
  type SupportDraft,
} from "../web/src/support";
import { supportFailure } from "../web/src/support-actions";
import {
  initialSupportTab, supportTab, supportTabBadge, supportReplyHref, supportMailLine, supportKindDropdown, SUPPORT_STATUS_FILTERS, UNVERIFIED,
  type SupportTabState,
} from "../web/src/platform-support";
import { initialPlat, platformView, platformPage, platformDialogs, platformTabBar, PLAT_TABS, type PlatState } from "../web/src/platform";
import { sidebarView, NAV_CLOSED } from "../web/src/sidebar";
import { orgPickerView, initialOrgsUi } from "../web/src/org-picker";
import { render, initialState, helpSection, type AppState } from "../web/src/render";
import { siteFooter, CONTACT_HREF, SITE_CONTACT } from "../web/src/site-chrome";
import { legalView, TERMS, PRIVACY } from "../web/src/legal";
import { landingView } from "../web/src/landing";
import { parseHash, hashForRoute, sameRoute, pageKey } from "../web/src/hash";
import { ApiError, isGlobalPath } from "../web/src/api";
import { RELEASES } from "../web/src/releases";
import { SUPPORT_KINDS, SUPPORT_MESSAGE_MAX, SUPPORT_SUBJECT_MAX, SUPPORT_HONEYPOT, SUPPORT_FALLBACK_EMAIL, type SupportReport } from "@shared/support-core";
import coreSource from "../shared/support-core.ts?raw";

const UA = "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0";
const draft = (over: Partial<SupportDraft> = {}): SupportDraft => ({
  ...initialSupport(), open: true, context: { route: "#tickets/7", org: "acme", version: "0.25", userAgent: UA }, ...over,
});
const report = (over: Partial<SupportReport> = {}): SupportReport => ({
  id: 7, kind: "bug", subject: "Board drag drops the card", message: "Dragging a ticket to Testing snaps it back.\nSecond line.",
  reporter: { handle: "maya", name: "Maya Ortiz", email: "maya@acme.test" }, contact_email: null, org: { slug: "acme", name: "Acme" },
  route: "#tickets", app_version: "0.25", user_agent: UA, status: "open", resolved_by: null, resolved_at: null,
  created_at: "2026-10-09T10:00:00.000Z", mail: { status: "sent", at: "2026-10-09T10:00:01.000Z", error: null }, ...over,
});
const tab = (over: Partial<SupportTabState> = {}): SupportTabState => ({ ...initialSupportTab(), ...over });
/** The element tree of a piece of markup: tag names and nesting, no attributes or text. */
const skeletonOf = (html: string): string => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(\/?)([a-z0-9]+)[^>]*?(\/?)>/gi, "<$1$2$3>").replace(/>[^<]+</g, "><").replace(/\s+/g, "");

describe("the support dialog", () => {
  it("is nothing while closed, and one root-level overlay when open", () => {
    expect(supportDialog(initialSupport())).toBe("");
    const html = supportDialog(draft());
    expect(html.trim().startsWith(`<div data-overlay="support"`)).toBe(true);
    expect(html.match(/data-overlay=/g)).toHaveLength(1);
    expect(html).toContain(`role="dialog"`);
    expect(html).toContain(`aria-modal="true"`);
    expect(html).toContain(`aria-labelledby="support-t"`);
    expect(html).toContain("cnpy-cmodal"); // the app's modal shell: its motion and its reduced-motion rule
  });

  it("has ONE kind switch — the app's segmented() — with Bug, Question and Feedback, and each kind's own words", () => {
    for (const kind of SUPPORT_KINDS) {
      const html = supportDialog(draft({ kind }));
      expect(html.match(/data-seg="support-kind"/g)).toHaveLength(1);
      expect(html).toContain("cnpy-seg ");
      for (const label of ["Bug", "Question", "Feedback"]) expect(html).toContain(`>${label}</button>`);
      expect(html).toContain(`>${SUPPORT_COPY[kind].title}</div>`);
      expect(html).toContain(SUPPORT_COPY[kind].send);
      expect(html).not.toContain("<select");
    }
    // The two signed-in entries are the same dialog on a different kind.
    expect(SUPPORT_ENTRIES.map((e) => [e.label, SUPPORT_COPY[e.kind].title])).toEqual([["Report a bug", "Report a bug"], ["Contact support", "Contact support"]]);
  });

  it("fields: an optional subject and a required message, capped by the shared numbers", () => {
    const html = supportDialog(draft({ subject: `a "quoted" <subject>`, message: "<b>bold</b> & more" }));
    expect(html).toContain(`id="support-subject"`);
    expect(html).toContain(`maxlength="${SUPPORT_SUBJECT_MAX}"`);
    expect(html).toContain("(optional)");
    expect(html).toMatch(/<textarea id="support-message"[^>]*maxlength="5000"[^>]*required/);
    expect(SUPPORT_MESSAGE_MAX).toBe(5000);
    expect(html).toContain(`value="a &quot;quoted&quot; &lt;subject&gt;"`);
    expect(html).toContain("&lt;b&gt;bold&lt;/b&gt; &amp; more</textarea>");
    expect(html).not.toContain("<b>bold</b>");
    // Every field names itself for the rerender's focus restore.
    expect(html).toContain(`data-field="supportSubject"`);
    expect(html).toContain(`data-field="supportMessage"`);
  });

  it("says exactly what is attached — the screen, the organization, the version, the browser — read-only, and that nothing else is", () => {
    const html = supportAttached({ route: "#tickets/7", org: "acme", version: "0.25", userAgent: UA });
    for (const [label, value] of [["Screen", "#tickets/7"], ["Organization", "acme"], ["Version", "0.25"], ["Browser", UA]]) {
      expect(html).toContain(`<dt>${label}</dt>`);
      expect(html).toContain(`>${value}</dd>`);
    }
    expect(html.match(/<dt>/g)).toHaveLength(4);
    expect(html).toContain("Nothing else is attached: no page content, and nothing from your organization.");
    expect(html).not.toMatch(/<input|<textarea|<button|type="checkbox"/); // a statement, not a choice
    // Outside an organization it says so rather than showing a blank.
    expect(supportAttached({ route: "", org: null, version: "0.25", userAgent: UA })).toContain("None: you are not inside an organization");
    // The message field is described by it, so a screen reader hears it before sending.
    expect(supportDialog(draft())).toContain(`aria-describedby="support-ctx support-err"`);
  });

  it("the version it attaches is the top release", () => {
    expect(RELEASES[0].version).toMatch(/^(\d+\.\d+|Unreleased)$/);
  });

  it("Send is inert until there is a message; while sending everything is disabled and it says so", () => {
    const empty = supportDialog(draft());
    expect(empty).toMatch(/data-act="supportSend" data-support-send disabled/);
    const ready = supportDialog(draft({ message: "It broke." }));
    expect(ready).toMatch(/data-act="supportSend" data-support-send class="cnpy-accentbtn"/);
    const busy = supportDialog(draft({ message: "It broke.", busy: true }));
    expect(busy).toContain("Sending…");
    expect(busy).toMatch(/data-support-send disabled aria-busy="true"/);
    expect(busy).toMatch(/<textarea id="support-message"[^>]* disabled/);
    expect(busy).toMatch(/<input id="support-subject"[^>]* disabled/);
    expect(busy).toContain("data-busy");
    expect(busy.match(/class="cnpy-seg-btn[^"]*"[^>]* disabled/g)).toHaveLength(3);
    expect(busy).toMatch(/data-act="supportClose" aria-label="Close" title="Close" class="cnpy-iconbtn" disabled/);
  });

  it("a failure keeps the person's text and says why, in an alert", () => {
    const html = supportDialog(draft({ subject: "Kept subject", message: "Kept message", error: "Your message wasn't sent. Check your connection and try again. What you wrote is still here." }));
    expect(html).toContain(`value="Kept subject"`);
    expect(html).toContain(">Kept message</textarea>");
    expect(html).toMatch(/<div id="support-err" data-support-error role="alert" style/);
    expect(html).toContain("What you wrote is still here.");
    expect(html).toMatch(/data-act="supportSend" data-support-send class="cnpy-accentbtn"/); // ready to try again
    // The sentences a failure maps to.
    expect(supportFailure(new Error("offline"))).toContain("wasn't sent");
    expect(supportFailure(new ApiError(400, "invalid payload"))).toContain("Shorten it");
    const limited = new ApiError(429, "rate_limited");
    limited.retryAfter = 3600;
    expect(supportFailure(limited)).toMatch(/^You've hit today's limit for messages to support; try again after /);
  });

  it("the form's structure is the same in every state, so a keystroke patches it in place", () => {
    const states = [draft(), draft({ message: "x" }), draft({ message: "x", busy: true }), draft({ message: "x", error: "Nope." }), draft({ kind: "feedback", subject: "s", message: "m".repeat(4800) })];
    const shapes = new Set(states.map((s) => skeletonOf(supportDialog(s))));
    expect(shapes.size).toBe(1);
    // …and the error slot is always there, hidden until there is something to say.
    expect(supportDialog(draft())).toMatch(/data-support-error role="alert" hidden/);
    // The sent state is a different body, replaced whole (`data-morph-key`).
    expect(supportDialog(draft())).toContain(`data-morph-key="support:form"`);
    expect(supportDialog(draft({ sent: { replyTo: null } }))).toContain(`data-morph-key="support:sent"`);
  });

  it("after sending it confirms, and says where a reply will go", () => {
    const html = supportDialog(draft({ sent: { replyTo: "maya@acme.test" } }));
    expect(html).toContain("Sent. We read every one; replies come to maya@acme.test.");
    expect(html).toContain(`role="status"`);
    expect(html).not.toContain("<textarea");
    expect(html).toContain(`data-act="supportClose" data-support-focus`);
    expect(html).toContain(`data-act="supportAgain"`);
    expect(supportSentSentence(null)).toBe("Sent. We read every one. Your account has no verified email address on file, so we can't reply by email.");
    expect(supportDialog(draft({ sent: { replyTo: `<x@y.z>` } }))).toContain("&lt;x@y.z&gt;");
  });

  it("client checks mirror the Worker's, and the counter only shows near the cap", () => {
    expect(supportProblem({ subject: "", message: "   " })).toBe("Write a message first.");
    expect(supportProblem({ subject: "", message: "ok" })).toBeNull();
    expect(supportProblem({ subject: "s".repeat(SUPPORT_SUBJECT_MAX + 1), message: "ok" })).toContain(String(SUPPORT_SUBJECT_MAX));
    expect(supportProblem({ subject: "", message: "m".repeat(SUPPORT_MESSAGE_MAX + 1) })).toContain("5,000");
    expect(supportCounter("short")).toBe("");
    expect(supportCounter("m".repeat(4600))).toBe("4,600 / 5,000");
  });

  it("the values the SPA imports live in a zod-free core", () => {
    expect(coreSource).not.toMatch(/from\s+["']zod["']/);
    expect(coreSource).not.toMatch(/^import /m);
  });

  it("motion is the modal's: off under prefers-reduced-motion; no new radius without its line in the corners block", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-cmodal-back, \.cnpy-cmodal-box/);
    const html = supportDialog(draft()) + supportDialog(draft({ sent: { replyTo: null } }));
    for (const r of new Set([...html.matchAll(/border-radius:(\d+)px/g)].map((m) => m[1]))) {
      expect(css, `border-radius:${r}px`).toContain(`[style*="border-radius:${r}px"]`);
    }
  });
});

describe("the ways in — signed in", () => {
  const ME = { handle: "maya", name: "Maya", color: "moss", avatar_url: null, role: null, identities: [], org: "Acme", admin: false, orgs: [], superadmin: false, pending_invites: 0 } as unknown as AppState["me"];
  const app = (over: Partial<AppState> = {}): AppState => ({ ...initialState(), view: "app", screen: "feed", me: ME, ...over });
  const header = (html: string) => html.slice(html.indexOf('<header class="cnpy-hdr"'), html.indexOf("</header>"));

  it("Report a bug is an icon button in the header, beside the theme toggle and its twin, on every screen the header shows on", () => {
    for (const screen of ["mywork", "feed", "tickets", "roadmap", "docs", "repo", "review", "settings", "guide", "releases", "handoffs", "prompts", "artifacts", "org", "search"] as const) {
      const h = header(render(app({ screen })));
      expect(h.match(/data-act="supportOpen"/g), screen).toHaveLength(1);
      const bug = h.match(/<button data-act="supportOpen" data-arg="bug"[^>]*>/)?.[0] ?? "";
      const theme = h.match(/<button data-act="cycleTheme"[^>]*>/)?.[0] ?? "";
      expect(bug, screen).toContain(`title="Report a bug" aria-label="Report a bug" aria-haspopup="dialog"`);
      expect(bug).toContain(`data-support-trigger="bug"`);
      // The same icon button: class and box, to the letter.
      expect(bug.match(/class="[^"]*" style="[^"]*"/)?.[0]).toBe(theme.match(/class="[^"]*" style="[^"]*"/)?.[0]);
      // Directly before the theme toggle, last but one in the right-hand cluster.
      expect(h.slice(h.indexOf(bug) + bug.length)).toMatch(/^\s*<svg[^>]*aria-hidden="true">[\s\S]*?<\/svg>\s*<\/button><button data-act="cycleTheme"/);
      // An icon only: no words in the button, and no button inside it.
      const inner = h.slice(h.indexOf(bug) + bug.length, h.indexOf("</button>", h.indexOf(bug)));
      expect(inner.replace(/<svg[\s\S]*<\/svg>/, "").trim()).toBe("");
      expect(inner).not.toContain("<button");
    }
    // At phone width it is one of the header's 40px icon buttons (a direct child of the cluster).
    expect(css).toContain(`[data-phone="1"] .cnpy-hdr-r > .cnpy-iconbtn`);
    expect(header(render(app()))).toMatch(/<div class="cnpy-hdr-r"[^>]*>[\s\S]*<button data-act="supportOpen" data-arg="bug"/);
  });

  it("Contact support is a tile in personal Settings, with a button that opens the dialog on Question", () => {
    const tile = helpSection();
    expect(tile).toMatch(/^<section class="cnpy-tile cnpy-surface cnpy-set-help">/);
    expect(tile).toContain(">Help</div>");
    expect(tile).toMatch(/<button data-act="supportOpen" data-arg="question" data-support-trigger="question"[^>]*aria-haspopup="dialog"[^>]*>Contact support<\/button>/);
    const html = render(app({ screen: "settings" }));
    expect(html).toContain(`cnpy-tile cnpy-surface cnpy-set-help"`);
    expect(html.match(/data-act="supportOpen" data-arg="question"/g)).toHaveLength(1);
    expect(html).toMatch(/<main data-morph="settings"/);
    expect(css).toContain(".cnpy-set-help { grid-column:1 / -1; }");
  });

  it("the sidebar has neither: its Help section is Guide and What's new, as before", () => {
    const html = sidebarView({
      screen: "feed", collapsed: false, navOpen: NAV_CLOSED, qView: "board", roadmapTab: "narrative", docSpace: "", docSpaces: [],
      counts: { review: 0, maintenance: 0, tickets: 0, handoffs: 0, prompts: 0 }, me: { handle: "maya", name: "Maya", color: "moss" }, displayName: "Maya", logo: "",
    } as Parameters<typeof sidebarView>[0]);
    expect(html).not.toContain("supportOpen");
    expect(html).not.toContain("Report a bug");
    expect(html).not.toContain("Contact support");
    expect(html.match(/class="cnpy-navrow /g)).toHaveLength(13);
    // …and the rail's short-window steps are the ones it had.
    expect(css).not.toContain("@media (max-height: 1000px)");
    expect(css).toContain(`[data-phone="0"][data-collapsed="0"] .cnpy-sec { height:25px; padding-top:6px; }`);
    expect(css).toContain(`[data-phone="0"] .cnpy-foot { padding:6px 10px; }`);
  });

  it("the org picker keeps its link: a person with no organization has no header and no Settings", () => {
    const picker = orgPickerView({ me: { handle: "maya", name: "Maya", identities: [] }, mine: [], orgs: null, status: "ok", ui: initialOrgsUi(), hash: "" });
    expect(picker).toMatch(/data-act="supportOpen" data-arg="question" data-support-trigger="question"[^>]*>Contact support<\/button>/);
    expect(picker).not.toContain("goSettings");
  });

  it("the dialog is a root-level overlay over any screen and over the picker, in the app's modal", () => {
    const s = app();
    expect(render(s)).not.toContain(`data-overlay="support"`);
    s.support = draft();
    for (const screen of ["feed", "tickets", "settings", "guide"] as const) {
      const html = render({ ...s, screen });
      expect(html.match(/data-overlay="support"/g), screen).toHaveLength(1);
      expect(html).toContain(`data-support-layer class="cnpy-cmodal"`);
      expect(html).not.toContain("support-email");
    }
    const picker = render({ ...s, view: "orgs" });
    expect(picker).toContain(`data-overlay="support"`);
    expect(picker).toContain(`data-morph="orgs"`);
  });

  it("the requests are person-level: never prefixed with an organization", () => {
    expect(isGlobalPath("/api/support")).toBe(true);
    expect(isGlobalPath("/api/support/public")).toBe(true);
    expect(isGlobalPath("/api/platform/support/7/resolve")).toBe(true);
    expect(isGlobalPath("/api/supportx")).toBe(false);
  });
});

describe("the ways in — signed out (the site's Contact form)", () => {
  const anon = (over: Partial<SupportDraft> = {}): SupportDraft => draft({ anonymous: true, kind: "question", email: "", context: { route: "/pricing", org: null, version: "", userAgent: UA }, ...over });

  it("Contact is in the site footer: a button that opens the dialog on the landing page, a link to /?contact=1 on the static pages", () => {
    const here = siteFooter("dialog");
    expect(here).toMatch(/<button type="button" data-act="supportOpen" data-arg="question" data-support-trigger="question"[^>]*aria-haspopup="dialog"[^>]*>Contact<\/button>/);
    expect(here).not.toContain(CONTACT_HREF);
    const there = siteFooter();
    expect(CONTACT_HREF).toBe("/?contact=1");
    expect(there).toContain(`<a href="/?contact=1">Contact</a>`);
    expect(there).not.toContain("data-act");
    const landing = landingView({ dark: false, signInOpen: false, signedIn: false, seen: new Set<string>(), feature: null });
    expect(landing).toMatch(/data-act="supportOpen" data-arg="question"[^>]*>Contact<\/button>/);
    expect(landing).toContain(`data-morph="landing"`);
    // The static pages (pricing, terms, privacy) carry the link.
    expect(legalView(TERMS, false)).toContain(`<a href="/?contact=1">Contact</a>`);
    expect(legalView(PRIVACY, false)).toContain(`<a href="/?contact=1">Contact</a>`);
  });

  it("signed out the same dialog renders over the landing page, as a root-level overlay beside the morphed page, in the sign-in card", () => {
    const s: AppState = { ...initialState(), view: "auth", authStep: "login", support: anon() };
    const html = render(s);
    expect(html.match(/data-overlay="support"/g)).toHaveLength(1);
    expect(html).toContain(`data-morph="landing"`);
    expect(html.indexOf(`data-overlay="support"`)).toBeGreaterThan(html.indexOf(`data-morph="landing"`));
    const dlg = supportDialog(anon());
    expect(dlg.trim().startsWith(`<div data-overlay="support" data-support-layer data-support-anon>`)).toBe(true);
    expect(dlg).toContain(`class="site-signin-back"`);
    expect(dlg).toContain(`class="site-signin-wrap"`);
    expect(dlg).toMatch(/role="dialog" aria-modal="true" aria-labelledby="support-t"[^>]*class="site-signin-card site-contact-card/);
    expect(dlg).not.toContain("cnpy-cmodal-box");
    // Its motion is the sign-in card's, and so is its reduced-motion rule.
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.site-signin-back, \.site-signin-card/);
    expect(css).toContain(".site-contact-card {");
  });

  it("fields: a required email first, the same kind switch (Question by default), an optional subject, the message", () => {
    const dlg = supportDialog(anon());
    expect(dlg).toMatch(/<input id="support-email" type="email"[^>]*data-act="supportEmail" data-field="supportEmail"[^>]*maxlength="254"[^>]*autocomplete="email"[^>]*required/);
    expect(dlg.indexOf("support-email")).toBeLessThan(dlg.indexOf(`data-seg="support-kind"`));
    expect(dlg).toMatch(/class="cnpy-seg-btn is-on"[^>]*>Question</);
    expect(dlg).toContain(`id="support-subject"`);
    expect(dlg).toContain(`id="support-message"`);
    expect(dlg).toContain(">Contact support</div>");
    // The signed-in form has no email field: the session says who is writing.
    expect(supportDialog(draft())).not.toContain("support-email");
  });

  it("says plainly what is sent — what was typed, the page, the browser — and links the Privacy Policy; nothing about an organization or a version", () => {
    const html = supportAttached({ route: "/pricing", org: null, version: "", userAgent: UA }, true);
    expect(html.match(/<dt>/g)).toHaveLength(2);
    expect(html).toContain("<dt>Page</dt>");
    expect(html).toContain(">/pricing</dd>");
    expect(html).toContain("<dt>Browser</dt>");
    expect(html).toContain("We receive what you typed above, the page you were on and your browser. Nothing else. Your email address is used only to reply to you.");
    expect(html).toMatch(/<a href="\/privacy" target="_blank" rel="noopener">Privacy Policy<\/a>/);
    expect(html).not.toMatch(/Organization|Version/);
  });

  it("the honeypot: off screen, out of the tab order, hidden from assistive technology, autocomplete off — and not display:none", () => {
    const dlg = supportDialog(anon());
    expect(dlg).toMatch(/<div class="cnpy-support-hp" aria-hidden="true"><label for="support-website">Website<\/label><input id="support-website" name="website" type="text" tabindex="-1" autocomplete="off" value="" \/><\/div>/);
    expect(SUPPORT_HONEYPOT).toBe("website");
    const rule = css.match(/\.cnpy-support-hp \{[^}]*\}/)?.[0] ?? "";
    expect(rule).toContain("position:absolute");
    expect(rule).toContain("left:-10000px");
    expect(rule).not.toContain("display:none");
    expect(supportDialog(draft())).not.toContain("cnpy-support-hp");
  });

  it("Send needs an address and a message; the address is checked for shape before it is sent", () => {
    expect(supportDialog(anon({ message: "Hi" }))).toMatch(/data-support-send disabled/);
    expect(supportDialog(anon({ email: "a@b.co" }))).toMatch(/data-support-send disabled/);
    expect(supportDialog(anon({ email: "a@b.co", message: "Hi" }))).toMatch(/data-support-send class="cnpy-accentbtn"/);
    expect(supportProblem({ anonymous: true, email: "", subject: "", message: "Hi" })).toBe("Enter your email address, so we can reply.");
    for (const email of ["nope", "a@b", "a@b.co, c@d.io", "Name <a@b.co>"]) expect(supportProblem({ anonymous: true, email, subject: "", message: "Hi" }), email).toBe("Enter an email address, like name@example.com.");
    expect(supportProblem({ anonymous: true, email: " a@b.co ", subject: "", message: "Hi" })).toBeNull();
  });

  it("after sending: \"Sent. We'll reply to <email>.\"; a failure keeps the text; a 429 says when to try again; the global cap sends them to the address", () => {
    expect(supportSentSentence("visitor@example.test", true)).toBe("Sent. We'll reply to visitor@example.test.");
    const sent = supportDialog(anon({ sent: { replyTo: "visitor@example.test" } }));
    expect(sent).toContain("Sent. We&#39;ll reply to visitor@example.test.");
    expect(sent).not.toContain("<textarea");
    const failed = supportDialog(anon({ email: "a@b.co", subject: "Kept", message: "Kept message", error: supportFailure(new Error("offline"), true) }));
    expect(failed).toContain(`value="a@b.co"`);
    expect(failed).toContain(`value="Kept"`);
    expect(failed).toContain(">Kept message</textarea>");
    expect(failed).toContain("What you wrote is still here.");
    const limited = new ApiError(429, "rate_limited");
    limited.retryAfter = 3600;
    expect(supportFailure(limited, true)).toMatch(/^You've hit today's limit for messages from this form; try again after .+\. Or email hello@trov\.dev\.$/);
    const closed = new ApiError(429, "support_closed");
    closed.retryAfter = 3600;
    expect(supportFailure(closed, true)).toBe("We can't take messages through this form right now. Email hello@trov.dev instead. What you wrote is still here to copy.");
    expect(SUPPORT_FALLBACK_EMAIL).toBe(SITE_CONTACT);
    expect(supportFailure(new ApiError(400, "too_fast"), true)).toContain("Give it a moment");
    expect(supportFailure(new ApiError(400, "invalid payload"), true)).toContain("Check the email address");
  });

  it("its structure is stable while the form is up, and it loads no third-party script", () => {
    const states = [anon(), anon({ email: "a@b.co", message: "x" }), anon({ email: "a@b.co", message: "x", busy: true }), anon({ message: "x", error: "Nope." })];
    expect(new Set(states.map((s) => skeletonOf(supportDialog(s)))).size).toBe(1);
    expect(supportDialog(anon())).toContain(`data-morph-key="support:anon:form"`);
    const dlg = supportDialog(anon()) + supportDialog(anon({ sent: { replyTo: "a@b.co" } }));
    expect(dlg).not.toMatch(/<script|<iframe|turnstile|recaptcha|hcaptcha/i);
    for (const r of new Set([...dlg.matchAll(/border-radius:(\d+)px/g)].map((m) => m[1]))) expect(css, `border-radius:${r}px`).toContain(`[style*="border-radius:${r}px"]`);
  });
});

describe("Platform › Support — the list", () => {
  const plat = (over: Partial<SupportTabState> = {}): PlatState => ({ ...initialPlat(), superadmin: true, tab: "support", support: tab(over) });

  it("is a tab of the Platform page's tabBar(), with the count of open reports on it", () => {
    expect(PLAT_TABS).toContain("support");
    const bar = platformTabBar("support", 3);
    expect(bar).toContain(`role="tablist"`);
    expect(bar).toMatch(/id="plat-tab-support"[^>]*aria-selected="true"[^>]*>Support<span class="cnpy-badge" data-n="3" title="3 open reports">3<\/span>/);
    // Unknown and zero are the same hidden badge (`data-n="0"`), so the tab never shows a guessed number.
    expect(supportTabBadge(null)).toContain(`data-n="0"`);
    expect(supportTabBadge(0)).toContain(`data-n="0"`);
    expect(supportTabBadge(1)).toContain(`title="1 open report"`);
    // The count shows on every tab, not only its own.
    const other = platformView({ ...plat({ open: 2 }), tab: "orgs", orgs: { status: "ok", data: [] } });
    expect(other).toMatch(/id="plat-tab-support"[^>]*>Support<span class="cnpy-badge" data-n="2"/);
    expect(platformPage(plat(), "platform", "andres")).toContain(`data-morph="platform"`);
  });

  it("loading is a skeleton of the table — never the empty state early", () => {
    for (const status of ["idle", "loading"] as const) {
      const html = supportTab(tab({ list: { status, data: [] } }));
      expect(html).toContain(`data-skel="plat-support"`);
      expect(html).toContain(`aria-busy="true"`);
      expect(html).toContain("Loading support reports…");
      expect(html).not.toContain("data-support-empty");
      expect(html).not.toContain("No open reports");
    }
  });

  it("a failed read degrades to a sentence with a retry", () => {
    const html = supportTab(tab({ list: { status: "error", data: [] } }));
    expect(html).toContain(`role="alert"`);
    expect(html).toContain("Couldn't load the support reports.");
    expect(html).toContain(`data-act="platReload"`);
    expect(html).not.toContain("data-support-empty");
    // A failed REFRESH keeps the rows already on screen.
    expect(supportTab(tab({ list: { status: "error", data: [report()] } }))).toContain("Board drag drops the card");
  });

  it("empty says so for the filter on screen", () => {
    const ok = { status: "ok" as const, data: [] };
    expect(supportTab(tab({ list: ok, open: 0 }))).toContain("No open reports");
    expect(supportTab(tab({ list: ok, open: 0 }))).toContain("No open reports. ");
    expect(supportTab(tab({ list: ok, status: "resolved" }))).toContain("No resolved reports");
    expect(supportTab(tab({ list: ok, status: "all" }))).toContain("No reports yet");
    expect(supportTab(tab({ list: ok, status: "open", kind: "question" }))).toContain("No open question reports");
  });

  it("the table: kind, subject, who, organization, when, status — each row a button that opens the report", () => {
    const rows = [report(), report({ id: 6, kind: "question", subject: `How do <i>plans</i> work?`, org: null, status: "resolved", reporter: { handle: "sam", name: null, email: null } })];
    const html = supportTab(tab({ list: { status: "ok", data: rows }, open: 1 }));
    expect(html).toMatch(/<span>Kind<\/span><span>Subject<\/span><span>From<\/span><span>Organization<\/span><span>When<\/span><span>Status<\/span>/);
    expect(html).toContain("<strong>1</strong> open report.");
    expect(html.match(/data-act="platSupportOpen"/g)).toHaveLength(2);
    expect(html).toMatch(/<button type="button" data-act="platSupportOpen" data-arg="7"[^>]*class="plat-row plat-support-grid"/);
    for (const part of [">BUG<", ">QUESTION<", "Maya Ortiz", "@maya", ">acme<", ">OPEN<", ">RESOLVED<", "@sam", "&mdash;"]) expect(html, part).toContain(part);
    expect(html).toContain("How do &lt;i&gt;plans&lt;/i&gt; work?");
    expect(html).not.toContain("<i>plans</i>");
    // The list shows no message body and no address: those are the report's.
    expect(html).not.toContain("Dragging a ticket");
    expect(html).not.toContain("maya@acme.test");
    expect(css).toContain(".plat-support-grid {");
  });

  it("filters: status is segmented(), kind is dropdown() — never a native select", () => {
    const html = supportTab(tab({ list: { status: "ok", data: [report()] }, status: "resolved", kind: "feedback" }));
    expect(html).toContain(`data-seg="plat-support-status"`);
    expect(SUPPORT_STATUS_FILTERS).toEqual(["open", "resolved", "all"]);
    for (const label of ["Open", "Resolved", "All"]) expect(html).toContain(`>${label}</button>`);
    expect(html).toMatch(/class="cnpy-seg-btn is-on"[^>]*>Resolved</);
    expect(html).toMatch(/<button type="button" id="plat-support-kind"[^>]*data-act="ddToggle"[^>]*aria-haspopup="listbox"/);
    expect(html).toContain(`<span class="cnpy-dd-v">Feedback</span>`);
    expect(html).not.toContain("<select");
    expect(supportKindDropdown("all").options.map((o) => o.label)).toEqual(["All kinds", "Bug", "Question", "Feedback"]);
    // Its menu is a root-level overlay of the page, present only while open.
    const p = plat({ list: { status: "ok", data: [] } });
    expect(platformDialogs(p, "platform")).toBe("");
    const open = platformDialogs(p, "platform", { open: "plat-support-kind", opening: true, closing: false });
    expect(open).toContain(`data-overlay="dd-plat-support-kind"`);
    expect(open).toContain(`data-dd-act="platSupportKind"`);
  });

  it("pages: a button for older reports only while there are some, busy and failed states included", () => {
    const data = { status: "ok" as const, data: [report()] };
    expect(supportTab(tab({ list: data, next: null }))).not.toContain("platSupportMore");
    expect(supportTab(tab({ list: data, next: 5 }))).toContain(">Show older reports</button>");
    expect(supportTab(tab({ list: data, next: 5, more: "loading" }))).toMatch(/data-act="platSupportMore"[^>]* disabled aria-busy="true"/);
    expect(supportTab(tab({ list: data, next: 5, more: "error" }))).toContain("Couldn't load more.");
  });
});

describe("Platform › Support — one report", () => {
  const open = (over: Partial<SupportReport> = {}, state: Partial<SupportTabState> = {}) => {
    const r = report(over);
    return supportTab(tab({ reportId: r.id, detail: { status: "ok", data: r }, ...state }));
  };

  it("shows the whole message, escaped and with its line breaks, and the attached context", () => {
    const html = open({ message: `Line one\n<script>alert(1)</script>` });
    expect(html).toContain(`data-support-detail="7"`);
    expect(html).toMatch(/data-support-message style="[^"]*white-space:pre-wrap[^"]*">Line one\n&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/div>/);
    expect(html).not.toContain("<script>");
    for (const [label, value] of [["From", "maya@acme.test"], ["Organization", ">acme<"], ["Screen", "#tickets"], ["Version", "0.25"], ["Browser", UA]]) {
      expect(html).toContain(`<dt>${label}</dt>`);
      expect(html).toContain(value);
    }
    expect(html).toContain("Nothing was read from their organization.");
    expect(html).toContain(`data-act="platSupportBack"`);
    // The list's filters belong to the list.
    expect(html).not.toContain("plat-support-status");
  });

  it("Resolve on an open report, Reopen on a resolved one — with who resolved it and busy states", () => {
    const o = open();
    expect(o).toMatch(/data-act="platSupportResolve"[^>]*class="cnpy-accentbtn"[^>]*>Resolve</);
    expect(o).not.toContain("platSupportReopen");
    const done = open({ status: "resolved", resolved_by: "andres", resolved_at: "2026-10-09T11:00:00.000Z" });
    expect(done).toMatch(/data-act="platSupportReopen"[^>]*>Reopen</);
    expect(done).toContain("resolved by @andres");
    expect(done).toContain(">RESOLVED<");
    expect(open({}, { busy: true })).toMatch(/data-act="platSupportResolve"[^>]* disabled aria-busy="true"[^>]*>Resolving…</);
    expect(open({}, { actionError: "The report wasn't resolved. Check your connection and try again." })).toContain(`role="alert"`);
  });

  it("Reply by email is a mailto to the reporter's address with the subject prefilled — and absent when there is no address", () => {
    expect(supportReplyHref(report())).toBe("mailto:maya@acme.test?subject=Re%3A%20%5BTrov%20bug%5D%20Board%20drag%20drops%20the%20card");
    expect(open()).toMatch(/<a href="mailto:maya@acme\.test\?subject=Re%3A%20%5BTrov%20bug%5D[^"]*" data-support-reply[^>]*>Reply by email<\/a>/);
    // A subject cannot add a header or a second recipient: it is one encoded value.
    const href = supportReplyHref(report({ subject: "x&cc=evil@x.io\nBcc: y@x.io" }))!;
    expect(href.split("?")[1]).toBe(`subject=${encodeURIComponent("Re: [Trov bug] x&cc=evil@x.io\nBcc: y@x.io")}`);
    expect(href).not.toMatch(/[&\n]/);
    for (const email of [null, "", "not an address", "a@b.c, evil@x.io", "a@b.c?cc=evil@x.io"] as (string | null)[]) {
      expect(supportReplyHref(report({ reporter: { handle: "sam", name: null, email } })), String(email)).toBeNull();
    }
    const none = open({ reporter: { handle: "sam", name: null, email: null } });
    expect(none).not.toContain("data-support-reply");
    expect(none).toContain("no verified email on file");
  });

  it("says what became of the mail to the operator — sent, failed with the (scrubbed) reason, skipped, unknown", () => {
    expect(supportMailLine({ status: "sent", at: new Date().toISOString(), error: null })).toBe("Mailed to you just now.");
    expect(supportMailLine({ status: "failed", at: "x", error: "resend 403: bad key [redacted]" })).toBe("The mail to you was not sent: resend 403: bad key [redacted]");
    expect(supportMailLine({ status: "skipped", at: "x", error: null })).toContain("SUPPORT_NOTIFY_EMAIL");
    expect(supportMailLine({ status: null, at: null, error: null })).toBe("No mail outcome was recorded.");
    expect(open({ mail: { status: "failed", at: "x", error: `<b>boom</b>` } })).toContain("&lt;b&gt;boom&lt;/b&gt;");
    expect(open({ mail: { status: "skipped", at: "x", error: null } })).toContain(`data-support-mail="skipped"`);
  });

  it("loading is a skeleton, a failed read an error with a retry, an unknown id says so — never a blank panel", () => {
    const loading = supportTab(tab({ reportId: 9, detail: { status: "loading", data: null } }));
    expect(loading).toContain(`data-skel="plat-support-detail"`);
    expect(loading).toContain(`data-act="platSupportBack"`);
    const failed = supportTab(tab({ reportId: 9, detail: { status: "error", data: null } }));
    expect(failed).toContain("Couldn't load this report.");
    expect(failed).toContain(`data-act="platReload"`);
    const missing = supportTab(tab({ reportId: 9, detail: { status: "error", data: null }, missing: true }));
    expect(missing).toContain("That report doesn&#39;t exist");
    // Another report's data is never shown under this id.
    expect(supportTab(tab({ reportId: 9, detail: { status: "ok", data: report({ id: 7 }) } }))).not.toContain("Board drag drops the card");
  });

  it("the list and a report are different things in the panel: each is replaced, not patched into the other", () => {
    expect(supportTab(tab())).toMatch(/^<div data-morph-key="plat-support:list">/);
    expect(supportTab(tab({ reportId: 7 }))).toMatch(/^<div data-morph-key="plat-support:report:7">/);
  });
});

describe("Platform › Support — a report sent signed out", () => {
  const anonReport = (over: Partial<SupportReport> = {}) => report({ id: 9, kind: "question", subject: "Do you have SSO?", reporter: null, contact_email: "visitor@example.test", org: null, route: "/pricing", app_version: null, ...over });

  it("the list tells it apart: a SIGNED OUT badge and the typed address where the person would be", () => {
    const html = supportTab(tab({ list: { status: "ok", data: [anonReport(), report()] }, open: 2 }));
    expect(html.match(/data-support-anon/g)).toHaveLength(1);
    expect(html).toMatch(/data-support-anon[^>]*>.*?>SIGNED OUT<\/span>.*?visitor@example\.test/s);
    expect(html).toContain(`from a signed-out visitor, open — open`);
    expect(html).toContain("@maya"); // the signed-in row is as it was
  });

  it("the report says Signed out, shows the address labelled unverified, and Reply by email uses it", () => {
    const r = anonReport();
    const html = supportTab(tab({ reportId: 9, detail: { status: "ok", data: r } }));
    expect(html).toContain(">SIGNED OUT<");
    expect(html).toContain("Signed out: sent from the public site, with no account");
    expect(html).toMatch(/visitor@example\.test <span data-support-unverified[^>]*>\(unverified, as typed\)<\/span>/);
    expect(UNVERIFIED).toBe("unverified, as typed");
    expect(supportReplyHref(r)).toBe("mailto:visitor@example.test?subject=Re%3A%20%5BTrov%20question%5D%20Do%20you%20have%20SSO%3F");
    expect(html).toMatch(/<a href="mailto:visitor@example\.test\?subject=[^"]*" data-support-reply/);
    expect(html).toContain("<dt>Page</dt>");
    expect(html).not.toContain("<dt>Organization</dt>");
    expect(html).not.toContain("<dt>Version</dt>");
    expect(html).toContain("nobody verified it; Trov has sent nothing to it.");
    expect(html).not.toContain("@null");
  });

  it("a typed address is a stranger's text: escaped, and never a mailto unless it is one plain address", () => {
    const html = supportTab(tab({ reportId: 9, detail: { status: "ok", data: anonReport({ contact_email: `<img src=x>@x.io` }) } }));
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&lt;img src=x&gt;@x.io");
    expect(html).not.toContain("data-support-reply");
    expect(supportReplyHref(anonReport({ contact_email: "a@b.co?cc=evil@x.io" }))).toBeNull();
  });
});

describe("the route #platform/support/<id>", () => {
  it("parses to the Support tab with the report, round-trips, and is the same PAGE as the tab", () => {
    const r = parseHash("#platform/support/12");
    expect(r).toMatchObject({ screen: "platform", platTab: "support", platReport: 12 });
    expect(hashForRoute(r)).toBe("#platform/support/12");
    const list = parseHash("#platform/support");
    expect(list).toMatchObject({ screen: "platform", platTab: "support" });
    expect(list.platReport).toBeUndefined();
    expect(hashForRoute(list)).toBe("#platform/support");
    expect(sameRoute(r, list)).toBe(false);
    expect(sameRoute(r, parseHash("#platform/support/12"))).toBe(true);
    expect(pageKey(r)).toBe(pageKey(list)); // opening a report never replays the page's entrance
    for (const bad of ["#platform/support/0", "#platform/support/abc", "#platform/support/1/2", "#platform/support/-3"]) {
      expect(parseHash(bad).platReport, bad).toBeUndefined();
    }
    // A report id never leaks onto another tab's address.
    expect(hashForRoute({ screen: "platform", ticketId: null, sprintId: null, platTab: "usage", platReport: 12 })).toBe("#platform/usage");
  });
});

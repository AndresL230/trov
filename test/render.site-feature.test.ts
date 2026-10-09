/**
 * The landing tour, explorable (web/src/landing.ts `featureDialog`, web/src/site-feature.ts): each
 * tour mockup is a card that opens its feature in a large dialog, and the For agents row's plugin
 * card shows the shared connect steps. Markup, a11y, the facts' wording, and the motion rules.
 */
import { describe, it, expect } from "vitest";
import { landingView, TOUR_KEYS, TOUR_FACTS, type TourKey } from "../web/src/landing";
import { initialState, render } from "../web/src/render";
import { fxMode, stepKey, trapIndex, FX_EXIT_MS, FX_MOVE_MS, type FeatureState } from "../web/src/site-feature";
import { PLUGIN_INSTALL, ONE_ORG_NOTE } from "../web/src/mcp-connect";
import { MOCK_KEYS, featureMock, mockText } from "../web/src/landing-mocks";
import { TICKET_STATUSES, TICKET_STATUS_LABEL } from "../shared/tickets-core";
import { ARTIFACT_STATUSES } from "../shared/artifacts-core";
import css from "../web/src/trov.css?raw";
import ticketsSrc from "../web/src/tickets.ts?raw";
import timelineSrc from "../web/src/timeline.ts?raw";
import myworkSrc from "../web/src/mywork.ts?raw";
import handoffsSrc from "../web/src/handoffs.ts?raw";
import artifactsSrc from "../web/src/artifacts.ts?raw";
import landingSrc from "../web/src/landing.ts?raw";
import renderSrc from "../web/src/render.ts?raw";

const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
const page = (feature: FeatureState | null = null) => landingView({ dark: false, signInOpen: false, seen: new Set(), feature });
const open = (key: string, dir: -1 | 0 | 1 = 0, mode: FeatureState["mode"] = "vt") => page({ key, dir, mode });
const dialog = (html: string) => html.slice(html.indexOf('<div data-overlay="feature"'));
const NAMES: Record<TourKey, string> = { docs: "Docs", feed: "Feed", tickets: "Tickets", roadmap: "Roadmap", mywork: "My Work", handoffs: "Handoffs", artifacts: "Artifacts" };

describe("tour cards — every mockup opens its feature", () => {
  const html = page();
  it("each of the seven has ONE labelled control, Explore; the card is the same action for a pointer only", () => {
    for (const key of TOUR_KEYS) {
      expect(html).toContain(`class="site-lift site-fxcard cnpy-hitbox" data-fx="${key}"`);
      expect(html).toContain(`<button type="button" data-act="openFeature" data-arg="${key}" class="cnpy-hit" tabindex="-1" aria-hidden="true"></button>`);
      expect(html).toMatch(new RegExp(`<button type="button" data-act="openFeature" data-arg="${key}:btn" aria-haspopup="dialog" class="site-explore"[^>]*>Explore ${NAMES[key]}<svg`));
    }
    expect(html.match(/data-act="openFeature"/g)?.length).toBe(14);
  });
  it("no button holds another button, on the page or in the dialog", () => {
    for (const h of [html, open("tickets")]) expect(h).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  });
  it("is closed until asked for", () => {
    expect(html).not.toContain('data-overlay="feature"');
    expect(render({ ...initialState(), view: "auth", authStep: "login" })).not.toContain('data-overlay="feature"');
  });
});

describe("the feature dialog", () => {
  it("is one root-level overlay beside the page, and the page under it is the same markup", () => {
    const closed = render({ ...initialState(), view: "auth", authStep: "login" });
    const opened = render({ ...initialState(), view: "auth", authStep: "login", siteFeature: { key: "feed", dir: 0, mode: "css" } });
    const site = (h: string) => h.slice(h.indexOf('<div class="cnpy-site"'), h.indexOf("</footer>"));
    expect(opened).toContain('<div data-overlay="feature" class="site-fx" data-in="css">');
    expect(site(opened)).toBe(site(closed));
  });

  it("is a modal dialog named by its title and described by its position", () => {
    const d = dialog(open("docs"));
    expect(d).toContain('role="dialog" aria-modal="true" aria-labelledby="site-fx-title" aria-describedby="site-fx-pos"');
    expect(d).toContain('<h2 id="site-fx-title">A library that stays reviewed</h2>');
    expect(d).toContain('<span id="site-fx-pos" aria-live="polite"><span class="site-vh">Docs, </span>1 of 7</span>');
    expect(d).toContain('data-act="closeFeature" title="Close" aria-label="Close"');
    expect(d).toContain('<div data-act="closeFeature" class="site-fx-back"></div>');
  });

  it("shows each feature's name, promise, its own mockup and its facts — and does not repeat the row's paragraph", () => {
    const whole = page();
    for (const key of TOUR_KEYS) {
      const d = dialog(open(key));
      expect(d).toContain(`data-morph-key="${key}"`);
      expect(d).toContain(`aria-label="How ${NAMES[key]} works"`);
      for (const f of TOUR_FACTS[key]) expect(d).toContain(f.replace(/'/g, "&#39;"));
      // The dialog draws the screen itself (landing-mocks.ts), fuller than the row's teaser, and with no image.
      expect(d).toContain(`<div class="site-fx-mock" aria-hidden="true">${featureMock(key)}</div>`);
      expect(whole).not.toContain(featureMock(key));
      expect(d).not.toMatch(/<img\b/);
      expect(d).not.toMatch(/<h2 id="site-fx-title">[^<]*<\/h2>\s*<p>/);
    }
  });

  it("previous and next name where they go, and wrap at both ends", () => {
    expect(dialog(open("docs"))).toContain('data-act="stepFeature" data-arg="prev" class="site-fx-nav" style="border-radius:9px" aria-label="Previous: Artifacts"');
    expect(dialog(open("docs"))).toContain('aria-label="Next: Feed"');
    expect(dialog(open("artifacts"))).toContain('aria-label="Next: Docs"');
    expect(dialog(open("artifacts"))).toContain("7 of 7");
    expect(dialog(open("roadmap")).match(/class="site-fx-dot is-on"/g)?.length).toBe(1);
    expect(dialog(open("roadmap")).match(/class="site-fx-dot[ "]/g)?.length).toBe(7);
  });

  it("carries how it was opened and which way it stepped, and nothing else changes on a rerender", () => {
    expect(dialog(open("feed", 1, "css"))).toContain('data-in="css"');
    expect(dialog(open("feed", 1, "css"))).toContain('data-morph-key="feed" data-dir="1"');
    expect(dialog(open("feed", -1, "none"))).toContain('data-dir="-1"');
    expect(open("feed", 1, "vt")).toBe(open("feed", 1, "vt"));
  });

  it("three or four facts each, all of them the Guide's own words", () => {
    // The Guide's prose with its inline helpers unwrapped: ${gStrong("Board")} → Board.
    const guide = renderSrc.slice(renderSrc.indexOf("function guideView"))
      .replace(/\$\{g(?:Strong|Code|Em)\("([^"]*)"\)\}/g, "$1").replace(/&amp;/g, "&");
    // For each fact, a phrase of it that must still stand in the Guide.
    const anchors: Record<TourKey, string[]> = {
      docs: ["split into Technical and Product spaces, each grouped into sections like Architecture and Decisions", "Version history keeps every earlier version", "The live doc stays untouched until a person promotes", "New doc lets you propose one yourself"],
      feed: ["A timeline of everything that shipped, from people and agents alike", "a short brief in plain words", "says whether an agent wrote it", "Filter by author, tag, or time"],
      tickets: ["Anyone can file a bug, request, question, or access ask", "Drag a card to change its status or its place in a column", "the same tickets grouped by sprint", "only a person closes a ticket: a merged PR never does"],
      roadmap: ["Narrative reads the plan and its sprint cards", "each bar runs from a sprint's start to its due date", "tickets closed", "always a person's call"],
      mywork: ["Trov opens here", "your open tickets, with their sprint and when it is due", "what agents staged, with Promote, Ratify and Reject right there", "It reads only what Trov has already captured, so it loads instantly"],
      handoffs: ["A handoff is a note from one session to the next: the task, what's done, what's next, the files that matter", "addressed to you, a teammate, or anyone", "claims only the one you pick", "Unclaimed handoffs expire after 7 days"],
      artifacts: ["An artifact is a page an agent or person made: an HTML design, a markdown report, an SVG or mermaid diagram, an image, a PDF, or a file", "links it to the ticket or sprint it came from", "only a person can give it", "Compare versions diffs any two"],
    };
    for (const key of TOUR_KEYS) {
      expect(TOUR_FACTS[key].length, key).toBeGreaterThanOrEqual(3);
      expect(TOUR_FACTS[key].length, key).toBeLessThanOrEqual(4);
      expect(anchors[key].length).toBe(TOUR_FACTS[key].length);
      for (const a of anchors[key]) expect(guide, `${key}: ${a}`).toContain(a);
    }
  });
});

describe("the dialog's mockups — each screen drawn from the real one (landing-mocks.ts)", () => {
  it("there is one for each of the seven features", () => {
    expect([...MOCK_KEYS]).toEqual([...TOUR_KEYS]);
    for (const key of MOCK_KEYS) expect(featureMock(key).length, key).toBeGreaterThan(2500);
    expect(new Set(MOCK_KEYS.map((k) => featureMock(k))).size).toBe(7);
  });

  it("is inert: nothing focusable, nothing that acts, hidden from a screen reader", () => {
    for (const key of MOCK_KEYS) {
      const html = featureMock(key);
      expect(html, key).not.toMatch(/<(?:button|a|input|select|textarea|img|iframe)\b/);
      expect(html, key).not.toMatch(/\b(?:data-act|tabindex|href|onclick|contenteditable)=/);
      expect(dialog(open(key))).toContain('<div class="site-fx-mock" aria-hidden="true">');
    }
  });

  it("draws with the theme's tokens only, and never scales", () => {
    for (const key of MOCK_KEYS) {
      const html = featureMock(key);
      expect(html, key).not.toMatch(/style="[^"]*(?:#[0-9a-fA-F]{3,8}\b|rgba?\()/);
      expect(html, key).not.toMatch(/transform\s*:\s*scale|zoom\s*:/);
    }
    expect(rules).not.toMatch(/\.site-fx-mock[^{]*\{[^}]*(?:zoom|scale)/);
  });

  it("Tickets: a column per real status, in the product's order, and the table's own groups and chips", () => {
    const text = mockText("tickets").toLowerCase();
    let at = -1;
    for (const s of TICKET_STATUSES) {
      const next = text.indexOf(TICKET_STATUS_LABEL[s].toLowerCase(), at + 1);
      expect(next, TICKET_STATUS_LABEL[s]).toBeGreaterThan(at);
      at = next;
    }
    expect(featureMock("tickets").match(/min-width:0;display:flex;flex-direction:column;gap:6px/g)?.length).toBe(TICKET_STATUSES.length);
    expect(renderSrc).toContain("Submit a ticket");
    expect(text).toContain("submit a ticket");
    for (const real of ["Unassigned", "sub-ticket", "Backlog", "GitHub #", "TITLE", "PRIORITY", "STATUS", "ASSIGNEE"]) {
      expect(ticketsSrc, real).toContain(real);
      expect(text, real).toContain(real.toLowerCase());
    }
    // The page's teaser uses the product's words too: no invented priorities or counts.
    expect(page()).not.toMatch(/\bP[0-3]\b|\d+ comments/);
  });

  it("Artifacts: the three real statuses in order, the version menu and Linked work", () => {
    const text = mockText("artifacts").toLowerCase();
    let at = -1;
    for (const s of ARTIFACT_STATUSES) { const next = text.indexOf(s, at + 1); expect(next, s).toBeGreaterThan(at); at = next; }
    for (const real of ["LATEST", "New version", "Linked work", "Attach ticket", "VERSIONS", "Compare v", "Ratified v", "Org"]) {
      expect(artifactsSrc, real).toContain(real);
      expect(text, real).toContain(real.toLowerCase());
    }
  });

  it("every other mock says what its real screen says", () => {
    const guide = renderSrc;
    const pairs: [Parameters<typeof mockText>[0], string, string[]][] = [
      ["docs", guide, ["You're viewing the", "promoted", "Review proposal", "Version history", "New doc", "Updated by"]],
      ["feed", guide, ["For reading", "For agents", "This week", "Whole team, last 7 days", "Everything this week", "Top tags", "Waiting on review"]],
      ["roadmap", timelineSrc, ["Sprints on the calendar", "In progress", "Upcoming", "Overdue", "Ready", "all tickets closed", "Today", "Done", "Next due", "starts in"]],
      ["roadmap", guide, ["Narrative", "Timeline", "New sprint"]],
      ["mywork", myworkSrc, ["Tickets for you", "Needs your review", "Your sessions", "Queue", "View all", "to promote", "to ratify", "Promote", "Ratify", "Reject", "Dashboard", "PRs", "Deploys", "due this week", "overdue"]],
      ["handoffs", handoffsSrc, ["WAITING TO BE CLAIMED", "HISTORY", "PENDING", "CLAIMED", "EXPIRED", "Where it stands", "Claim", "Anyone", "Handoffs you sent or that were left for you. A pending handoff waits until a session claims it."]],
    ];
    for (const [key, src, words] of pairs) {
      const text = mockText(key).toLowerCase();
      for (const w of words) {
        expect(src.toLowerCase(), `${key}: the product no longer says "${w}"`).toContain(w.toLowerCase());
        expect(text, `${key}: "${w}"`).toContain(w.toLowerCase());
      }
    }
  });

  it("uses one fictional team throughout", () => {
    const all = MOCK_KEYS.map((k) => mockText(k)).join(" ");
    for (const ours of ["Maya", "Leo", "Sam", "#212", "#142", "ADR-0012", "Hardening the public API", "acme/api"]) expect(all).toContain(ours);
  });

  it("has ONE box at the dialog's size; a phone drops the secondary panes instead of shrinking them", () => {
    expect(rules).toContain(".site-fx-mock { position:relative; width:100%; height:100%; min-width:0; min-height:0; }");
    expect(rules).toMatch(/@media \(max-width:640px\) \{[^@]*\.fxm-wide \{ display:none !important; \}/);
  });
});

describe("site-feature — the logic around the dialog", () => {
  it("picks the motion: reduced motion wins, a hidden tab or no View Transitions falls back to keyframes", () => {
    expect(fxMode({ vt: true, reduced: false, hidden: false })).toBe("vt");
    expect(fxMode({ vt: false, reduced: false, hidden: false })).toBe("css");
    expect(fxMode({ vt: true, reduced: false, hidden: true })).toBe("css");
    expect(fxMode({ vt: true, reduced: true, hidden: false })).toBe("none");
    expect(fxMode({ vt: false, reduced: true, hidden: true })).toBe("none");
  });
  it("steps through the features and wraps", () => {
    expect(stepKey(TOUR_KEYS, "docs", 1)).toBe("feed");
    expect(stepKey(TOUR_KEYS, "docs", -1)).toBe("artifacts");
    expect(stepKey(TOUR_KEYS, "artifacts", 1)).toBe("docs");
    expect(stepKey(TOUR_KEYS, "nope", 1)).toBe("feed");
  });
  it("keeps Tab inside: wraps both ways, and enters from outside at the near end", () => {
    expect(trapIndex(3, 0, false)).toBe(1);
    expect(trapIndex(3, 2, false)).toBe(0);
    expect(trapIndex(3, 0, true)).toBe(2);
    expect(trapIndex(3, -1, false)).toBe(0);
    expect(trapIndex(3, -1, true)).toBe(2);
    expect(trapIndex(0, -1, false)).toBe(-1);
  });
});

describe("the dialog's motion rules (trov.css)", () => {
  const from = rules.indexOf(":root { --fx-ease");
  const block = rules.slice(from, rules.indexOf(".site-signin-back {", from));
  it("ONE clock, defined once: a curve that eases at both ends and three lengths, mirrored by site-feature.ts", () => {
    expect(rules).toContain(":root { --fx-ease:cubic-bezier(0.4, 0, 0.2, 1); --fx-fast:.18s; --fx-base:.24s; --fx-slow:.3s; }");
    expect(rules.match(/--fx-ease:/g)?.length).toBe(1);
    expect(FX_EXIT_MS).toBe(180);
    expect(FX_MOVE_MS).toBe(300);
    // Everything that moves reads the clock: no literal duration and no second curve in the block.
    const timed = [...block.matchAll(/(?:animation|transition|animation-duration|animation-timing-function):[^;}]*/g)].map((m) => m[0]);
    expect(timed.length).toBeGreaterThan(12);
    for (const t of timed) {
      if (/none/.test(t)) continue;
      expect(t, t).toMatch(/var\(--fx-(?:fast|base|slow|ease)\)/);
      expect(t.replace(/var\([^)]*\)/g, "").replace(/\.08s/, ""), t).not.toMatch(/\d+m?s\b|cubic-bezier|ease/);
    }
  });
  it("only transform and opacity move, and every shadow is static", () => {
    for (const m of block.matchAll(/transition:([^;}]*)/g)) if (!/none/.test(m[1])) expect(m[1].trim().split(" ")[0], m[0]).toMatch(/^(transform|opacity)$/);
    for (const m of block.matchAll(/@keyframes [\w-]+ \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)) {
      for (const prop of m[1].matchAll(/([a-z-]+):/g)) expect(prop[1], m[0]).toMatch(/^(opacity|transform)$/);
    }
    expect(block).toContain(".site-fx[data-moving] :is(.site-fx-back, .site-fx-panel, .site-fx-titles, .site-fx-mock, .site-fx-facts) { will-change:transform, opacity; }");
    expect(block.replace(/\.site-fx\[data-moving\][^}]*\}/, "")).not.toContain("will-change");
  });
  it("the card-to-dialog morph is scoped to the transition site-feature.ts starts", () => {
    expect(rules).toMatch(/\.site-fx-panel \{[^}]*view-transition-name:site-fx;/);
    expect(rules).toMatch(/html\.site-fx-vt::view-transition-group\(site-fx\) \{ animation-duration:var\(--fx-slow\); animation-timing-function:var\(--fx-ease\); overflow:clip;\s*box-shadow:/);
    // Never unscoped: the first run's own morph must keep its timings.
    expect(rules).not.toMatch(/(^|[\s,}])::view-transition-(?:old|new|group)\(root\)/m);
  });
  it("the keyframe entrance plays only when no View Transition did, and the exit matches FX_EXIT_MS", () => {
    expect(rules).toContain('.site-fx[data-in="css"] .site-fx-panel { animation:site-fx-in var(--fx-slow) var(--fx-ease) both; }');
    expect(rules).toContain('.site-fx[data-in="css"] .site-fx-back { animation:site-fade var(--fx-slow) var(--fx-ease) both; }');
    expect(rules).not.toMatch(/\.site-fx\[data-in="vt"\][^{]*\{[^}]*animation/);
    expect(rules).toContain(".site-fx[data-closing] .site-fx-panel { animation:site-fx-out var(--fx-fast) var(--fx-ease) both; }");
    expect(rules).toContain(".site-fx[data-closing] .site-fx-back { animation:site-fx-fade-out var(--fx-fast) var(--fx-ease) both; }");
  });
  it("a step moves the text and the mockup from the side moved to — never the frame, and never the open animation", () => {
    expect(rules).toContain('.site-fx-main[data-dir="1"] :is(.site-fx-titles, .site-fx-mock, .site-fx-facts) { --fx-from:24px; animation:site-fx-step var(--fx-base) var(--fx-ease) both; }');
    expect(rules).toContain('.site-fx-main[data-dir="-1"] :is(.site-fx-titles, .site-fx-mock, .site-fx-facts) { --fx-from:-24px; animation:site-fx-step var(--fx-base) var(--fx-ease) both; }');
    // The frame has a fixed size, and nothing animates the panel, the stage or the footer on a step.
    expect(rules).toMatch(/\.site-fx-panel \{[^}]*height:min\(700px, 100%\);/);
    expect(rules).not.toMatch(/\.site-fx-main\[data-dir[^{]*(?:site-fx-panel|site-fx-stage\b|site-fx-foot)/);
    // The entrance is keyed to how the dialog was OPENED, which a step never changes.
    expect(dialog(open("feed", 1, "css"))).toContain('data-in="css"');
    expect(dialog(open("docs", 0, "css")).slice(0, 80)).toBe(dialog(open("feed", 1, "css")).slice(0, 80));
  });
  it("is all off under prefers-reduced-motion", () => {
    expect(rules).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.site-fx, \.site-fx \*, \.site-fx \*::before, \.site-fx \*::after \{ animation:none !important; transition:none !important; \}\s*\.site-fxcard, \.site-fxcard::after, \.site-explore svg \{ transition:none !important; \}\s*\}/);
  });
  it("a phone gets a full-height sheet with thumb-sized controls", () => {
    expect(rules).toMatch(/@media \(max-width:640px\) \{[^@]*\.site-fx-panel \{ height:100dvh; \}\s*\.site-fx-nav \{ min-height:44px; \}/);
  });
});

describe("For agents — the plugin card", () => {
  const html = page();
  const card = html.slice(html.indexOf('data-rv="agents-plugin"'), html.indexOf('id="site-security"'));
  it("shows the shared install commands and connect steps, with their Copy button", () => {
    for (const line of PLUGIN_INSTALL.split("\n")) expect(card).toContain(line);
    expect(card).toContain('data-act="copyPluginInstall"');
    expect(card).toContain('<ol aria-label="Connect Claude Code"');
    expect(card).toContain("Authenticate");
    expect(card).toContain(ONE_ORG_NOTE);
    expect(card).toContain("How Trov works, in the Guide");
  });
  it("retypes none of it: landing.ts holds no copy of the commands", () => {
    expect(landingSrc).not.toContain("/plugin marketplace add");
    expect(landingSrc).not.toContain("/plugin install");
  });
  it("the row is two weighted columns, one under 900px", () => {
    expect(rules).toContain(".site-agents-row { margin-top:48px; display:grid; grid-template-columns:minmax(0, 1.65fr) minmax(0, 1fr); gap:16px; align-items:stretch; }");
    expect(rules).toContain("@media (max-width:900px) { .site-agents-row { grid-template-columns:minmax(0, 1fr); } }");
  });
});

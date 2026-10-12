// Status marks (web/src/marks.ts, web-ui.md › Status marks): a state is a glyph or a small shape and a
// sentence-case word — never the bordered, tinted, letter-spaced UPPERCASE pill. The signed-out site draws
// its states with the app's own helpers, so neither can drift back to a hand-drawn pill.
import { describe, it, expect } from "vitest";
import { landingView } from "../web/src/landing";
import * as mocks from "../web/src/landing-mocks";
import { MOCK_KEYS, featureMock } from "../web/src/landing-mocks";
import {
  stateMark, glyph, ticketStatusIcon, ticketStatusMark, priorityIcon, priorityMark, handoffMark, artifactStatusMark, authorityMark,
  agentMark, kindMark, LOW_CONFIDENCE, TICKET_STATUS_TONE, TICKET_STATUS_HINT, HANDOFF_MARK, ARTIFACT_MARK, AUTHORITY_MARK, STATE_KIND,
  type Glyph, type StateKind,
} from "../web/src/marks";
import { placeTip, TIP_DELAY_MS } from "../web/src/tip";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";
import { TICKET_STATUSES, TICKET_STATUS_LABEL, TICKET_PRIORITIES } from "../shared/tickets-core";
import { ARTIFACT_STATUSES } from "../shared/artifacts-core";
import landingSrc from "../web/src/landing.ts?raw";
import mocksSrc from "../web/src/landing-mocks.ts?raw";

/** The old pill: a span with a 1px border that is ALSO in tracked capitals, or tinted in the label face. */
const PILL = /<span[^>]*style="(?=[^"]*border:1px solid)(?=[^"]*(?:text-transform:uppercase|font-family:var\(--label\)[^"]*background:color-mix|background:color-mix[^"]*font-family:var\(--label\)))[^"]*"/;
const page = () => landingView({ dark: false, signInOpen: false, seen: new Set(), feature: null });

describe("the marks themselves", () => {
  const all = [
    ...TICKET_STATUSES.map((s) => ticketStatusMark(s)),
    ...TICKET_PRIORITIES.map((p) => priorityMark(p)),
    ...(["pending", "claimed", "expired"] as const).map((s) => handoffMark(s)),
    ...ARTIFACT_STATUSES.map((s) => artifactStatusMark(s)),
    authorityMark("staged_pending"), authorityMark("unpromoted"), authorityMark("draft"),
    agentMark(), LOW_CONFIDENCE(),
    ...(Object.keys(STATE_KIND) as StateKind[]).map((k) => kindMark("Word", k)),
  ];

  it("are never a pill: no border, no fill, no capitals, no tracking", () => {
    for (const m of all) {
      expect(m).not.toMatch(/border:|background:|text-transform|letter-spacing/);
      expect(m).toMatch(/^<span (?:data-mtip="[^"]*" )?style="display:inline-flex;align-items:center;/);
    }
  });

  it("draw their shape as an SVG element (never a ● character) and say a sentence-case word", () => {
    for (const m of all) {
      expect(m).toContain("<svg");
      expect(m).not.toContain("●");
      const word = m.replace(/<svg[\s\S]*?<\/svg>/g, "").replace(/<[^>]+>/g, "");
      expect(word.length).toBeGreaterThan(0);
      expect(word).not.toMatch(/^[A-Z]{2,}( [A-Z]+)*$/); // never shouting
      // A state starts with a capital; the byline's "agent" reads inside a sentence ("Leo Park · agent").
      if (m !== agentMark()) expect(word[0]).toBe(word[0].toUpperCase());
    }
  });

  it("give every glyph its own shape, so a state reads without its colour", () => {
    const shapes = (["todo", "half", "most", "done", "declined", "warn"] as Glyph[]).map((g) => glyph(g, "x"));
    expect(new Set(shapes).size).toBe(shapes.length);
    for (const k of Object.keys(HANDOFF_MARK) as (keyof typeof HANDOFF_MARK)[]) expect(HANDOFF_MARK[k].word).toMatch(/^[A-Z][a-z]+$/);
    expect(new Set(Object.values(HANDOFF_MARK).map((m) => m.shape)).size).toBe(3);
    expect(new Set(Object.values(ARTIFACT_MARK).map((m) => m.shape)).size).toBe(3);
    // A state KIND is one tone and one shape: no two kinds look alike.
    expect(new Set(Object.values(STATE_KIND).map((k) => `${k.tone}|${k.shape}`)).size).toBe(Object.keys(STATE_KIND).length);
  });

  it("leave the normal state unmarked: a live search hit has no mark", () => {
    expect(AUTHORITY_MARK.live).toBeNull();
    expect(authorityMark("live")).toBe("");
  });

  it("name a glyph that stands alone, and hide one whose word sits beside it", () => {
    expect(ticketStatusIcon("testing")).toContain('role="img" aria-label="Testing"');
    expect(ticketStatusIcon("testing", 14, false)).toContain('aria-hidden="true"');
    expect(ticketStatusMark("testing")).toContain('aria-hidden="true"');
    for (const s of TICKET_STATUSES) expect(ticketStatusIcon(s)).toContain(`color:${TICKET_STATUS_TONE[s]}`);
  });

  it("escape the word", () => {
    expect(stateMark("<b>", "var(--red)", "dot")).toContain("&lt;b&gt;");
    expect(stateMark("x", "var(--red)", "dot", 12, `say "<i>"`)).toContain('data-mtip="say &quot;&lt;i&gt;&quot;"');
  });
});

describe("tooltips: every workflow mark says what its state means", () => {
  const tip = (html: string) => /data-mtip="([^"]*)"/.exec(html)?.[1] ?? null;

  it("a mark's tooltip explains the state — it never just repeats the word", () => {
    const marks: [string, string][] = [
      ...TICKET_STATUSES.map((s) => [ticketStatusMark(s), TICKET_STATUS_LABEL[s]] as [string, string]),
      ...(["pending", "claimed", "expired"] as const).map((s) => [handoffMark(s), HANDOFF_MARK[s].word] as [string, string]),
      ...ARTIFACT_STATUSES.map((s) => [artifactStatusMark(s), ARTIFACT_MARK[s].word] as [string, string]),
      ...(["staged_pending", "unpromoted", "draft"] as const).map((a) => [authorityMark(a), AUTHORITY_MARK[a]!.word] as [string, string]),
      [LOW_CONFIDENCE(), "Low confidence"], [agentMark(), "agent"],
    ];
    for (const [html, word] of marks) {
      const t = tip(html);
      expect(t, word).not.toBeNull();
      expect(t!.toLowerCase(), word).not.toBe(word.toLowerCase());
      expect(t!.length, word).toBeGreaterThan(word.length + 8);
      expect(t, word).toMatch(/\.$/); // a sentence
    }
    for (const s of TICKET_STATUSES) expect(tip(ticketStatusMark(s))).toBe(TICKET_STATUS_HINT[s]);
  });

  it("a glyph alone puts its name first, keeps its accessible name, and never a native <title>", () => {
    expect(tip(ticketStatusIcon("testing"))).toBe(`Testing. ${TICKET_STATUS_HINT.testing}`);
    expect(tip(priorityIcon("high"))).toBe("High priority");
    for (const s of TICKET_STATUSES) expect(ticketStatusIcon(s)).not.toContain("<title>");
    // Beside its word, the glyph is hidden from a screen reader and carries no tooltip of its own.
    expect(ticketStatusIcon("testing", 14, false)).not.toContain("data-mtip");
  });

  it("places the bubble above the mark, below it when there is no room, and inside the viewport", () => {
    const view = { width: 1000, height: 800 };
    const tipBox = { width: 200, height: 40 };
    // Room above: centred over the mark, 8px clear of it.
    expect(placeTip({ top: 300, left: 400, width: 100, height: 20 }, tipBox, view)).toEqual({ top: 252, left: 350, below: false });
    // Too near the top: below the mark.
    expect(placeTip({ top: 20, left: 400, width: 100, height: 20 }, tipBox, view)).toEqual({ top: 48, left: 350, below: true });
    // Near either edge: held 8px inside.
    expect(placeTip({ top: 300, left: 0, width: 20, height: 20 }, tipBox, view).left).toBe(8);
    expect(placeTip({ top: 300, left: 990, width: 10, height: 20 }, tipBox, view).left).toBe(792);
    expect(TIP_DELAY_MS).toBeGreaterThanOrEqual(150);
    expect(TIP_DELAY_MS).toBeLessThanOrEqual(500);
  });

  it("is ONE styled bubble: the app installs it once, it is themed, never on touch, still under reduced motion", () => {
    expect(mainSrc.match(/installMarkTips\(mount\)/g)).toHaveLength(1);
    const rule = /\.cnpy-mtip \{([^}]*)\}/.exec(css)?.[1] ?? "";
    for (const d of ["position:fixed", "background:var(--bg)", "border:1px solid var(--border-strong)", "color:var(--fg)", "pointer-events:none", "max-width:260px"]) expect(rule, d).toContain(d);
    expect(css).toMatch(/@media \(hover:none\) \{ \.cnpy-mtip \{ display:none; \} \}/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.cnpy-mtip[^{]*\{ transition:none; transform:none; \} \}/);
    expect(css).toContain("[data-cnpy-theme].cnpy-mtip { border-radius:calc(7px * var(--corner-scale)) !important; }");
  });
});

describe("the signed-out site uses the app's marks — no pill anywhere", () => {
  it("the page and its pricing section draw no pill", () => {
    const html = page();
    expect(html).not.toMatch(PILL);
    for (const word of [">STAGED<", ">PENDING<", ">LIVE<", ">DRAFT<", ">PUBLISHED<", ">RATIFIED<", ">CLAIMED<"]) {
      expect(html, word).not.toContain(word);
    }
  });

  it("every tour mock draws no pill", () => {
    for (const key of MOCK_KEYS) expect(featureMock(key), key).not.toMatch(PILL);
  });

  it("the site has no pill helper of its own: its states come from marks.ts", () => {
    expect("pill" in mocks).toBe(false);
    expect(mocksSrc).not.toMatch(/export function pill\b/);
    expect(landingSrc).toMatch(/from "\.\/marks"/);
    expect(mocksSrc).toMatch(/from "\.\/marks"/);
    // The site's hero, search, review, handoff and artifact states are the app's own marks.
    const html = page();
    expect(html).toContain(LOW_CONFIDENCE(12));
    expect(html).toContain(authorityMark("staged_pending", 11));
    expect(html).toContain(handoffMark("claimed", 11));
    expect(html).toContain(artifactStatusMark("ratified", 10.5));
    expect(featureMock("tickets")).toContain(ticketStatusMark("in_progress", 11));
    for (const s of TICKET_STATUSES) expect(featureMock("tickets")).toContain(`${TICKET_STATUS_LABEL[s]}`);
  });
});

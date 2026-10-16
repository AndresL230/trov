/**
 * The AI screens (web/src/ai-ui.ts, mywork.ts `briefTile`, repo-ai.ts, the Feed's Trov entries,
 * org-ai.ts, Platform › Usage) in each state they can be in — ready, empty, capped, and proposed for
 * the themes; admin vs member where it differs — fed by `shared/ai-fixtures.ts`. Pure: HTML strings
 * over a real render() pass or the screen's own function. The field-ABSENT case is pinned by
 * test/render.ai-absent.test.ts.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const mdMock = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (body: string) => `<div class="mock-live-md">${mdMock(body)}</div>`,
  renderMarkdownInline: (text: string) => mdMock(text),
}));
import { TROV_MARK_PATH } from "../shared/mark";
import { render, initialState, feedShown, FEED_AI_NOTE, FEED_NO_TROV, type AppState } from "../web/src/render";
import { briefTile, sessionsTile } from "../web/src/mywork";
import { repoStateSection, themesSection, bandHeight, weekLabel, type RepoAiProps } from "../web/src/repo-ai";
import { repoView, type RepoProps } from "../web/src/repo";
import { repoSample } from "../web/src/repo-sample";
import {
  AI_EMPTY, initialAiUi, aiCite, aiCapped, aiDay, aiSuggestionChip, aiWrongBtn, aiFeedback, aiFromLine, aiFeedTip, type AiUi,
} from "../web/src/ai-ui";
import { parseFeedbackArg } from "../web/src/ai-actions";
import { aiHiddenKey, AI_TIP } from "../web/src/ai-ui";
import { aiMark, AI_NOT_OFFICIAL } from "../web/src/marks";
import { aiTab, allowanceLine } from "../web/src/org-ai";
import { usageView, orgUsageBlock } from "../web/src/platform-usage";
import { PRIVACY } from "../web/src/legal";
import { AI_LEGAL_DRAFT } from "@shared/legal-core";
import css from "../web/src/trov.css?raw";
import { briefFixture, repoStateFixture, themesFixture, feedFixtures, aiPreviewFixtures } from "@shared/ai-fixtures";
import { aiItemRef, AI_BRIEF_LINE_MAX, AI_BRIEF_NEXT_MAX, AI_BRIEF_WHY_MAX, AI_NEVER_SENT, AI_SENDS, AI_SENDS_ALL, type AiSettings, type AiThemeRange, type AiThemes } from "@shared/ai-core";
import type { DashboardData } from "@shared/dashboard";
import type { FeedRow } from "@shared/rows";
import type { OrgUsage, PlatformUsageResponse } from "@shared/orgs";
import { loadWebChunks } from "./helpers/web-chunks";
import { capReached, meterPct } from "@shared/plans";

// The lazy screens (web-ui.md › The app's bundles) render themselves, not their skeletons.
loadWebChunks();

const NOW = new Date("2026-10-14T12:00:00.000Z");
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterAll(() => { vi.useRealTimers(); });

const ME = { handle: "andres", name: "Andres", avatar_url: null, color: "sky" as const, identities: [], orgs: [{ slug: "trov", name: "Trov", role: "admin" as const }], superadmin: false, pending_invites: 0 };
const PERSONS = [{ handle: "andres", name: "Andres", color: "sky" as const, avatar_url: null, role: null }];
function app(o: Partial<AppState>, role: "admin" | "member" = "admin"): AppState {
  return { ...initialState(), view: "app", me: { ...ME, orgs: [{ ...ME.orgs[0], role }] }, orgSlug: "trov", persons: { status: "ok", data: PERSONS }, ...o };
}
const dash = (o: Partial<DashboardData> = {}): DashboardData => ({ person: "andres", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false, ...o });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&hellip;/g, "…").replace(/\s+/g, " ").trim();
const ui = (o: Partial<AiUi> = {}): AiUi => ({ ...initialAiUi(), ...o });
const rp = (o: Partial<RepoAiProps> = {}): RepoAiProps => ({ ui: ui(), admin: true, repo: "AndresL230/trov", ...o });
const themes = (mode: "ready" | "empty" | "capped" | "proposed"): Record<AiThemeRange, AiThemes> =>
  ({ "8w": themesFixture(mode, "8w", NOW), quarter: themesFixture(mode, "quarter", NOW) });

// ── the kit ─────────────────────────────────────────────────────────────────

describe("the kit (ai-ui.ts)", () => {
  it("the AI mark is the Trov logo in the accent, an SVG element with its tooltip — never a pill", () => {
    const m = aiMark(12, "Written by Trov from x. Not official; check the sources.");
    expect(m).toContain(`d="${TROV_MARK_PATH}"`);
    expect(m).toContain('viewBox="0 0 100 100"');
    expect(m).toContain("color:var(--accent)");
    expect(m).toContain('data-mtip="Written by Trov from x. Not official; check the sources."');
    expect(m).toContain('aria-hidden="true"');
    expect(m).not.toMatch(/border|uppercase|●/);
    expect(aiMark(12, null, "Written by Trov")).toContain('role="img" aria-label="Written by Trov"');
  });
  it("a source is a link only when it has a page: GitHub in a new tab, an in-app route in place, else text", () => {
    expect(aiCite({ ref: "pr:173", label: "#173", href: "https://github.com/a/b/pull/173" })).toMatch(/<a href="https:\/\/github.com\/a\/b\/pull\/173" target="_blank" rel="noopener"[^>]*>#173<\/a>/);
    const inApp = aiCite({ ref: "ticket:14", label: "#14", href: "#tickets/14" });
    expect(inApp).toContain('href="#tickets/14"');
    expect(inApp).not.toContain("target=");
    expect(aiCite({ ref: "x", label: "a page-less thing", href: null })).toMatch(/^<span[^>]*>a page-less thing<\/span>$/);
    // Anything else the server could send is never made a link.
    expect(aiCite({ ref: "x", label: "bad", href: "javascript:alert(1)" })).not.toContain("<a");
    expect(aiCite({ ref: "x", label: "<b>", href: null })).toContain("&lt;b&gt;");
  });
  it("From …: the shown sources, then 'and N more'", () => {
    const f = feedFixtures(NOW)[0].ai!;
    expect(text(aiFromLine(f.sources, f.moreCount))).toBe("From #173 , 65b9f1f , a1c04e2 and 2 more");
    const g = feedFixtures(NOW)[1].ai!;
    expect(text(aiFromLine(g.sources, g.moreCount))).toBe("From feat/hosting-screens and run 4812");
  });
  // e2e FD-4 (Phase H): an entry whose sources could not be read had the tooltip "Written by Trov from . Not official…".
  it("the entry's tooltip names its sources, and with none it says only that Trov wrote it", () => {
    const f = feedFixtures(NOW)[0].ai!;
    expect(aiFeedTip(f.sources, f.moreCount)).toBe(`Written by Trov from #173, 65b9f1f, a1c04e2 and 2 more. ${AI_NOT_OFFICIAL}`);
    expect(aiFeedTip([], 0)).toBe(`Written by Trov. ${AI_NOT_OFFICIAL}`);
    expect(aiFeedTip([], 2)).toBe(`Written by Trov from 2 sources. ${AI_NOT_OFFICIAL}`);
  });
  it("Wrong? carries the item it is about, and only a well-formed body is ever sent back", () => {
    const b = aiFeedback("feed", "990001", "feed", "claude-haiku-5-5");
    const btn = aiWrongBtn(b);
    expect(btn).toContain('data-act="aiWrong"');
    // A thumbs-down icon button: no visible word, its name and tooltip say what it does.
    expect(btn).toContain('aria-label="Wrong? Hide this and tell Trov it is wrong"');
    expect(btn).toContain('data-mtip="Wrong? Hides this for you and tells Trov."');
    expect(btn).toContain("<svg");
    expect(btn).not.toContain(">Wrong?<");
    const arg = btn.match(/data-arg="([^"]+)"/)![1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    expect(parseFeedbackArg(arg)).toEqual({ itemType: "feed", itemRef: "990001", kind: "feed", model: "claude-haiku-5-5", promptVersion: null });
    expect(parseFeedbackArg(JSON.stringify({ itemType: "nope", itemRef: "1", kind: "x" }))).toBeNull();
    expect(parseFeedbackArg("not json")).toBeNull();
  });
  it("the capped line names when it resumes, and offers Upgrade to Pro only on Free", () => {
    expect(aiDay("2026-11-01")).toBe("Nov 1");
    const free = aiCapped({ upgrade: true }, "your brief resumes Nov 1");
    expect(text(free)).toContain("Monthly AI allowance used; your brief resumes Nov 1. Upgrade to Pro");
    expect(free).toContain('data-act="orgGo" data-arg="general"');
    expect(aiCapped({ upgrade: false }, "x resumes Nov 1")).not.toContain("Upgrade to Pro");
  });
});

describe("the suggestion chip (#157)", () => {
  const chip = (o: Partial<Parameters<typeof aiSuggestionChip>[1]> = {}) => aiSuggestionChip(
    { key: "s-7", id: 7, label: "Billing", reason: "it touches checkout and the plan block.", cites: [{ ref: "pr:136", label: "#136", href: "https://github.com/a/b/pull/136" }] },
    { open: false, busy: false, unavailable: false, canAct: true, ...o },
  );
  it("is drawn unlike a value a person set: a dashed outline, the AI mark, muted words", () => {
    const h = chip();
    expect(h).toContain("border:1px dashed var(--border-strong)");
    expect(h).toContain(`d="${TROV_MARK_PATH}"`);
    expect(h).toContain("color:var(--fg-55)");
    expect(text(h)).toContain("Suggested: Billing , because…");
  });
  it("its reason is one tap away: a real disclosure button, closed then open", () => {
    const closed = chip();
    expect(closed).toMatch(/<button type="button" data-act="aiReason" data-arg="s-7" aria-expanded="false" aria-controls="ai-why-s-7"/);
    expect(closed).toMatch(/id="ai-why-s-7" class="cnpy-ai-why" hidden/);
    const open = chip({ open: true });
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toMatch(/id="ai-why-s-7" class="cnpy-ai-why" hidden/);
    expect(text(open)).toContain("because it touches checkout and the plan block.");
    expect(open).toContain(">#136</a>");
  });
  // e2e § 6 K (Phase H): pressed from the keyboard, the screen's rebuild dropped focus to <body> (ticket detail,
  // Unplaced, the themes' lanes) — a keyboard user could not press it again or move on from it. The rerender puts
  // focus back on the element with the same `data-field` (main.ts), so each such control names one.
  it("the because… disclosure and a theme lane keep keyboard focus across the rebuild (a data-field each)", () => {
    expect(chip()).toMatch(/data-act="aiReason" data-arg="s-7" aria-expanded="false" aria-controls="ai-why-s-7" data-field="aiReason:s-7"/);
    const h = themesSection(themes("ready"), rp());
    const lanes = [...h.matchAll(/data-act="aiThemesLane" data-arg="([^"]+)"[^>]*data-field="aiThemesLane:([^"]+)"/g)];
    expect(lanes.length).toBeGreaterThan(1);
    for (const m of lanes) expect(m[2]).toBe(m[1]);
  });
  it("Accept and Dismiss for whoever may act; a busy write holds them; 'Not available yet' after a 409", () => {
    expect(chip()).toContain('data-act="aiAccept" data-arg="7"');
    expect(chip()).toContain('data-act="aiDismiss" data-arg="7"');
    expect(chip({ busy: true })).toMatch(/data-act="aiAccept" data-arg="7" disabled aria-busy="true"/);
    const na = chip({ unavailable: true });
    expect(na).toContain(">Not available yet</span>");
    expect(na).not.toContain("aiAccept");
    const reader = chip({ canAct: false, waiting: "Waiting for an admin" });
    expect(reader).not.toContain("aiAccept");
    expect(reader).toContain("Waiting for an admin");
  });
  it("is never a button inside a button, and wraps in a narrow column", () => {
    const h = chip({ extra: '<button type="button" data-act="aiRenameOpen">Rename</button>' });
    expect(h.startsWith("<div")).toBe(true);
    expect(h).toContain("flex-wrap:wrap");
    expect(h).toContain("max-width:100%");
  });
});

// ── My Work › Your brief ────────────────────────────────────────────────────

describe("My Work › Your brief", () => {
  const mw = (state: "ready" | "empty" | "capped", o: Partial<AppState> = {}) =>
    render(app({ screen: "mywork", mywork: { status: "ok", data: dash({ brief: briefFixture(state, NOW) }) }, ...o }));

  it("ready: the first tile — Now / Recently / Next, the byline, the thumbs-down", () => {
    const html = mw("ready");
    const labels = [...html.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
    // The visual order: Brief, then Needs your review over Docs you own; Your sessions beside Tickets for you; Repo
    // beside Queued handoffs.
    expect(labels).toEqual(["Your brief", "Needs your review", "Docs you own", "Your sessions", "Tickets for you", "Repo monitor", "Queued handoffs"]);
    const card = html.slice(html.lastIndexOf("<section", html.indexOf('data-mw="brief"')), html.lastIndexOf("<section", html.indexOf('data-mw="review"')));
    const t = text(card);
    expect(t).toContain("Your brief");
    expect(t).toContain("You are partway through the hosting screens");
    expect(t).toContain("Written by Trov, 12m ago");
    expect(card).toContain("Written by Trov from your sessions, pull requests, tickets and handoffs. Not official; check the sources.");
    // The thumbs-down sits at the bottom right, after the byline.
    expect(card.indexOf('data-act="aiWrong"')).toBeGreaterThan(card.indexOf("Written by Trov, 12m ago"));
    for (const w of ["Now", "Recently", "Next", "feat/hosting-screens", "CI run 4812", "#173", "#172", "#171"]) expect(t).toContain(w);
  });
  it("ready: each Next row is a state mark, the item's linked title and a muted why", () => {
    const card = briefTile(briefFixture("ready", NOW));
    const rows = card.split(/class="mw-brief-next[ "]/).slice(1);
    expect(rows).toHaveLength(3);
    expect(text(rows[0])).toContain("Failing");
    expect(rows[0]).toContain("var(--red)");
    expect(rows[0]).toMatch(/<a href="https:\/\/github.com\/AndresL230\/trov\/actions\/runs\/4812"[^>]*>Fix the Netlify connect test<\/a>/);
    expect(text(rows[0])).toContain("It blocks the hosting PR you are working on.");
    expect(text(rows[1])).toContain("Handoff");
    expect(rows[1]).toMatch(/<a href="#handoffs\/3"[^>]*>Performance plan for trov.dev<\/a>/);
    expect(text(rows[2])).toContain("#14");
    expect(rows[2]).toMatch(/<a href="#tickets\/14"[^>]*>Guided repository setup<\/a>/);
  });
  it("with a brief, the bento is laid out by area: Docs you own and Queued handoffs are small tiles, Artifacts is not drawn", () => {
    const html = mw("ready");
    expect(html).toContain('class="mw-bento mw-bento-brief cnpy-stagger"');
    const tiles = [...html.matchAll(/data-mw="(\w+)"/g)].map((m) => m[1]);
    expect(tiles).toEqual(["brief", "review", "docs", "sessions", "tickets", "repo", "handoffs"]);
    // Docs you own (short) stacks under Needs your review beside the brief, so the brief keeps its own height (the
    // owner, 2026-10-16); Tickets for you is wide beside Your sessions (BR-OWNER-3); Repo wide beside Queued handoffs.
    expect(css).toContain(`.mw-bento-brief { grid-template-areas:
  "brief brief brief brief brief brief brief brief review review review review"
  "brief brief brief brief brief brief brief brief docs docs docs docs"
  "sessions sessions sessions sessions tickets tickets tickets tickets tickets tickets tickets tickets"
  "repo repo repo repo repo repo repo repo hand hand hand hand";`);
    // Docs you own's row takes what the brief has over Needs your review, which is slim: one-line titles, 64px rows.
    expect(css).toContain("  grid-template-rows:auto 1fr auto auto; }");
    expect(css).toContain('.mw-side-body[data-side="review"] .mw-side-row { height:64px; }');
    expect(css).toContain("  .mw-bento-brief { grid-template-areas:none; grid-template-rows:none; }");
    // A phone stacks Brief, Needs your review, Tickets for you, Repo, then the rest — and the entrance follows it.
    for (const [k, n] of [["brief", 1], ["review", 2], ["tickets", 3], ["repo", 4], ["sessions", 5], ["docs", 6], ["handoffs", 7]] as const) {
      expect(css).toContain(`  .mw-bento-brief > [data-mw="${k}"]${k === "brief" ? ", .mw-bento-brief > .cnpy-ai-leave" : ""} { order:${n}; }`);
    }
    expect(css).toContain('  [data-enter] .mw-bento-brief.cnpy-stagger > [data-mw="tickets"] { --n:2; }');
    expect(css).toContain('  [data-enter] .mw-bento-brief.cnpy-stagger > [data-mw="repo"] { --n:3; }');
    // In the brief's bento Needs your review and Tickets for you are in their two-row mode; Repo, wide, is not.
    const tileOf = (k: string) => { const o = html.lastIndexOf("<section", html.indexOf(`data-mw="${k}"`)); return html.slice(o, html.indexOf("</section>", o)); };
    for (const k of ["review", "tickets"]) expect(tileOf(k), k).toMatch(/mw-side-(body|swap)/);
    expect(tileOf("repo")).not.toMatch(/mw-side-(body|swap)/);
    expect(text(html.slice(html.indexOf('data-mw="handoffs"')))).toContain("Queued handoffs");
    // NO tile scrolls (BR-OWNER-1): the rows size to what the tiles hold — no fixed height, no fixed rows, no
    // scrolling region in the brief bento — and the brief tile has no scrolling region at all.
    const open = html.lastIndexOf("<section", html.indexOf('data-mw="brief"'));
    expect(html.slice(open, html.indexOf("</section>", open))).not.toContain("mw-scroll");
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of rules.matchAll(/([^{}]*\.mw-bento-brief[^{}]*)\{([^{}]*)\}/g)) {
      expect(m[2], m[1].trim()).not.toMatch(/overflow(-y)?:\s*(auto|scroll)|(^|[;\s])height:(?!100%)|grid-template-rows:(?!none|auto 1fr auto auto;)/);
    }
    // Without a brief: the strip across the page, all three parts in one tile, no area layout.
    const plain = render(app({ screen: "mywork", mywork: { status: "ok", data: dash({}) } }));
    expect(plain).not.toContain("mw-bento-brief");
    expect(plain).toContain('data-mw="library"');
  });
  it("one shape (BR-OWNER-1): Now, Recently and Next always drawn, three Next slots, 'Nothing new.' where a part is empty", () => {
    const b = briefFixture("ready", NOW);
    const labels = (h: string) => [...h.matchAll(/>(Now|Recently|Next)<\/div>/g)].map((m) => m[1]);
    const slots = (h: string) => (h.match(/<li class="mw-brief-next/g) ?? []).length;
    expect(labels(briefTile(b))).toEqual(["Now", "Recently", "Next"]);
    expect(slots(briefTile(b))).toBe(AI_BRIEF_NEXT_MAX);
    // A part with nothing in it keeps its slot and says so; unused Next rows are kept, empty.
    const thin = briefTile({ ...b, recently: null, next: { items: b.next.items.slice(0, 1) } });
    expect(labels(thin)).toEqual(["Now", "Recently", "Next"]);
    expect(thin).toContain('<p class="mw-brief-text mw-brief-none">Nothing new.</p>');
    expect(slots(thin)).toBe(AI_BRIEF_NEXT_MAX);
    expect(thin.match(/<li class="mw-brief-next mw-brief-pad" aria-hidden="true"><\/li>/g)).toHaveLength(2);
    const noNext = briefTile({ ...b, next: { items: [] } });
    expect(text(noNext.slice(noNext.indexOf(">Next</div>") + 1))).toMatch(/^Next Nothing new\./);
    expect(slots(noNext)).toBe(AI_BRIEF_NEXT_MAX);
    // Every state holds the ready brief's height: the body box (trov.css `.mw-brief-body`).
    for (const st of ["ready", "empty", "capped"] as const) expect(briefTile(briefFixture(st, NOW))).toContain('<div class="mw-brief-body">');
    // Fixed boxes: a sentence two lines (44px) over its sources, a Next row 40px; the body 300px — its own height,
    // never stretched to the row's (the owner, 2026-10-16).
    expect(css).toContain(".mw-brief-body { min-height:300px;");
    expect(css).toContain(".mw-brief-text { margin:0; font-size:14px; line-height:22px; height:44px;");
    expect(css).toContain(".mw-brief-next { display:flex; gap:12px; align-items:baseline; min-width:0; height:40px; }");
    expect(css).not.toContain("align-content:space-between");
  });
  it("clamps an older, longer brief: three Next rows at most, the whole text as the box's tooltip, never cut in the markup", () => {
    const b = briefFixture("ready", NOW);
    const long = "You are partway through the hosting screens, " + "and the Netlify connect step still waits on the token check, ".repeat(4) + "so it is not merged.";
    const why = "It blocks the hosting pull request you are working on, and nothing else can land before it does.";
    const extra = b.next.items.map((it, k) => ({ ...it, ref: `ticket:${90 + k}`, title: `An older fourth-or-later item ${k}` }));
    const card = briefTile({ ...b, now: { ...b.now!, text: long }, next: { items: [{ ...b.next.items[0], why }, ...b.next.items.slice(1), ...extra] } });
    expect(long.length).toBeGreaterThan(AI_BRIEF_LINE_MAX);
    expect(why.length).toBeGreaterThan(AI_BRIEF_WHY_MAX);
    expect(card).toContain(`<p class="mw-brief-text" data-mtip="${long}">${long}</p>`);
    expect(card).toContain(`<span class="mw-brief-why" data-mtip="${why}">${why}</span>`);
    expect(card.match(/<li class="mw-brief-next cnpy-rise"/g)).toHaveLength(AI_BRIEF_NEXT_MAX);
    expect(card).not.toContain("An older fourth-or-later item");
    // Within the caps there is nothing to clamp, so no tooltip.
    expect(briefTile(b)).not.toMatch(/class="mw-brief-(text|why)" data-mtip/);
  });
  it("Next: an overdue item is marked Overdue in the danger tone; one row per kind's group, even from an older brief", () => {
    const b = briefFixture("ready", NOW);
    const od = { ref: "ticket:3", kind: "overdue" as const, title: "Lesson duration field", why: "Its sprint, Token rotation, was due Jun 10.", cites: [{ ref: "ticket:3", label: "#3", href: "#tickets/3" }] };
    const card = briefTile({ ...b, next: { items: [od, ...b.next.items.slice(1)] } });
    const row = card.split(/class="mw-brief-next[ "]/)[1];
    expect(text(row)).toContain("Overdue");
    expect(text(row)).not.toContain("Due soon");
    expect(row).toContain("var(--red)");
    // An older brief with three handoffs and a due beside an overdue: one handoff, one of the two, three rows at most.
    const h = (n: number) => ({ ref: `handoff:${n}`, kind: "handoff" as const, title: `Handoff ${n}`, why: "Left for you.", cites: [{ ref: `handoff:${n}`, label: `handoff #${n}`, href: `#handoffs/${n}` }] });
    const due = { ...od, ref: "ticket:4", kind: "due" as const, title: "Due-soon ticket" };
    const old = briefTile({ ...b, next: { items: [od, h(1), h(2), h(3), due] } });
    expect(text(old)).toContain("Handoff 1");
    expect(text(old)).not.toContain("Handoff 2");
    expect(text(old)).not.toContain("Due-soon ticket");
    expect(old.match(/<li class="mw-brief-next cnpy-rise"/g)).toHaveLength(2);
  });
  it("empty: the mock's sentence, no grid, no Wrong?", () => {
    const card = briefTile(briefFixture("empty", NOW));
    expect(text(card)).toContain(AI_EMPTY.brief);
    expect(card).not.toContain("mw-brief-grid");
    expect(card).not.toContain('data-act="aiWrong"');
    expect(card).toContain('data-ai-state="empty"');
  });
  it("capped: the last brief, then the allowance line with its resume date and Upgrade to Pro (Free only)", () => {
    const b = briefFixture("capped", NOW);
    const card = briefTile(b);
    expect(text(card)).toContain("You are partway through the hosting screens");
    expect(text(card)).toContain("Monthly AI allowance used; your brief resumes Nov 1. Upgrade to Pro");
    expect(briefTile({ ...b, upgrade: false })).not.toContain("Upgrade to Pro");
  });
  it("Wrong? hides it for this person", () => {
    const b = briefFixture("ready", NOW);
    expect(briefTile(b, true)).toBe("");
    const html = mw("ready", { ai: ui({ hidden: [`brief:${b.generatedAt}`] }) });
    expect(html).not.toContain('data-mw="brief"');
  });
});

// ── Repo › Summary › State ──────────────────────────────────────────────────

describe("Repo › Summary › State", () => {
  it("ready: an 18px headline, three columns with their marks and cites, 'from 6 events', Wrong?", () => {
    const h = repoStateSection(repoStateFixture("ready", NOW), rp());
    expect(h).toContain("font-size:18px");
    expect(text(h)).toContain("Release 0.30 is live; hosting screens are the open front, and main is green.");
    expect(text(h)).toContain("Written by Trov from 6 events, 2h ago");
    const cols = ["shipped", "inFlight", "attention"].map((k) => h.slice(h.indexOf(`data-ai-col="${k}"`)));
    expect(text(cols[0])).toContain("Shipped recently");
    expect(cols[0]).toContain("color:var(--green)");
    expect(text(cols[1])).toContain("In flight");
    expect(cols[1]).toContain("color:var(--blue)");
    expect(text(cols[2])).toContain("Needs attention");
    expect(cols[2]).toContain("color:var(--amber)");
    expect(h).toContain(">#173</a>");
    expect(h).toContain(">handoff #3</a>");
    expect(h).toContain(">Tickets</a>");
    expect(h).toContain('data-act="aiWrong"');
    expect(h).toContain("repo-state-cols");
  });
  it("omits 'from N events' when the count is unknown — never a guessed 0", () => {
    const h = repoStateSection({ ...repoStateFixture("ready", NOW), eventCount: null }, rp());
    expect(text(h)).toContain("Written by Trov, 2h ago");
    expect(h).not.toContain("0 events");
  });
  it("an old state says its age plainly (Q25): 'Written N days ago.' under the headline from the server's ageDays — a quiet fact, not a mark", () => {
    const old = repoStateSection({ ...repoStateFixture("ready", NOW), ageDays: 9 }, rp());
    expect(text(old)).toContain("Written 9 days ago.");
    expect(old).toMatch(/class="repo-state-age" style="[^"]*color:var\(--fg-55\)">Written 9 days ago\.<\/p>/);
    for (const fresh of [{ ageDays: 6 }, {}]) expect(repoStateSection({ ...repoStateFixture("ready", NOW), ...fresh }, rp())).not.toContain("repo-state-age");
  });
  it("empty: the mock's sentence; capped: the headline and 'this state is from <day> and resumes <day>'", () => {
    expect(text(repoStateSection(repoStateFixture("empty", NOW), rp()))).toContain(AI_EMPTY.state);
    const c = text(repoStateSection(repoStateFixture("capped", NOW), rp()));
    expect(c).toContain("Release 0.30 is live");
    expect(c).toContain("Monthly AI allowance used; this state is from Oct 5 and resumes Nov 1. Upgrade to Pro");
  });
  it("is the Summary tab's whole content — only with `state` on a live dashboard, never on the Overview", () => {
    const data = { ...repoSample(NOW.getTime()), state: repoStateFixture("ready", NOW) };
    const props = (o: Partial<RepoProps> = {}): RepoProps => ({ tab: "summary", range: "7d", driftOpen: false, repo: { status: "ok", data }, fetchedAt: NOW.getTime(), sample: false, admin: true, poll: null, productEnv: null, ai: rp(), ...o });
    const html = repoView(props());
    expect(html.indexOf('data-ai="repo_state"')).toBeGreaterThan(-1);
    expect(html).not.toContain("repo-panel");
    expect(repoView(props({ tab: "overview" }))).not.toContain('data-ai="repo_state"');
    expect(repoView(props({ sample: true }))).not.toContain('data-ai="repo_state"');
    expect(repoView(props({ tab: "code" }))).not.toContain('data-ai="repo_state"');
    expect(repoView(props({ ai: rp({ ui: ui({ hidden: [`repo_state:AndresL230/trov@${data.state.generatedAt}`] }) }) }))).not.toContain('data-ai="repo_state"');
  });
});

// ── Repo › Planning › Where the work went ───────────────────────────────────

describe("Repo › Planning › Where the work went", () => {
  it("ready: title, caption, the count line, the range switch and (admins) Edit themes", () => {
    const h = themesSection(themes("ready"), rp());
    const t = text(h);
    expect(t).toContain("Where the work went");
    expect(t).toContain("Since late August most of the work went to multi-org");
    expect(t).toMatch(/Themes and caption written by Trov from \d+ pull requests, 3h ago/);
    // Never a misleading zero (Q-S4): with no pull request counted the byline names none.
    const none = text(themesSection({ "8w": { ...themes("proposed")["8w"], prCount: 0 }, quarter: themes("proposed").quarter }, rp()));
    expect(none).not.toContain("from 0 pull requests");
    expect(none).toMatch(/written by Trov, /);
    expect(h).toContain('data-seg="repo-themes-range"');
    expect(t).toContain("8 weeks");
    expect(t).toContain("Quarter");
    expect(h).toContain('data-act="aiThemesEdit"');
    expect(themesSection(themes("ready"), rp({ admin: false }))).not.toContain("aiThemesEdit");
  });
  it("lanes are colour-chipped buttons; the first is picked, the others fade; its description and PRs show below", () => {
    const h = themesSection(themes("ready"), rp());
    const lanes = [...h.matchAll(/<button type="button" data-act="aiThemesLane" data-arg="([^"]+)" aria-pressed="(true|false)"/g)].map((m) => [m[1], m[2]]);
    expect(lanes).toEqual([["multiorg", "true"], ["tickets", "false"], ["repo", "false"], ["billing", "false"], ["site", "false"], ["polish", "false"]]);
    expect(h).toContain("background:var(--p-sky)");
    expect(h).toContain("opacity:.55");
    const detail = h.slice(h.indexOf("repo-lane-detail"));
    expect(text(detail)).toContain("The move from one team to many organizations");
    expect(detail).toContain(">#171 One GitHub account, several orgs</a>");
    // Picking another lane moves the selection and the detail.
    const b = themesSection(themes("ready"), rp({ ui: ui({ themesLane: "billing" }) }));
    expect(b).toMatch(/data-arg="billing" aria-pressed="true"/);
    expect(text(b.slice(b.indexOf("repo-lane-detail")))).toContain("Per-seat Pro, Stripe Checkout");
    // No button inside a lane button.
    for (const row of h.split('class="repo-lane"').slice(1)) expect(row.slice(0, row.indexOf("</button>"))).not.toContain("<button");
  });
  it("a range marked Wrong? keeps the card and its 8 weeks / Quarter switch while the other range is there; both out → nothing", () => {
    const all = themes("ready");
    const repo = "AndresL230/trov";
    // The read left 8 weeks out for this person (Wrong? on a past visit): the switch stays, Quarter one press away.
    const { "8w": _gone, ...onlyQuarter } = all;
    const h = themesSection(onlyQuarter, rp());
    expect(h).toContain('data-act="aiThemesRange"');
    expect(h).toContain('data-arg="quarter"');
    expect(text(h)).toContain("You marked this range wrong, so it is hidden for you until Trov writes it again.");
    expect(h).not.toContain("repo-band");
    expect(themesSection(onlyQuarter, rp({ ui: ui({ themesRange: "quarter" }) }))).toContain("repo-band");
    // Pressed this session (hidden at once): the same.
    const hidden = aiHiddenKey("themes", aiItemRef.themes(repo, "8w", all["8w"].generatedAt ?? "themes"));
    expect(themesSection(all, rp({ ui: ui({ hidden: [hidden] }) }))).toContain('data-act="aiThemesRange"');
    // Both out: no card.
    const hiddenQ = aiHiddenKey("themes", aiItemRef.themes(repo, "quarter", all.quarter.generatedAt ?? "themes"));
    expect(themesSection(onlyQuarter, rp({ ui: ui({ hidden: [hiddenQ] }) }))).toBe("");
  });
  it("bands are sized against the busiest week in view; a zero week draws no band", () => {
    expect(bandHeight(0, 6)).toBeNull();
    expect(bandHeight(6, 6)).toBe(36);
    expect(bandHeight(3, 6)).toBe(21);
    const h = themesSection(themes("ready"), rp());
    const first = h.slice(h.indexOf('data-arg="multiorg"'), h.indexOf('data-arg="tickets"'));
    // multiorg's first two weeks are 0: no band; 8 cells, 6 bands.
    expect((first.match(/class="repo-band"/g) ?? []).length).toBe(6);
  });
  it("week labels read 'Aug 24'; Quarter shows 13 weeks, 8 weeks shows 8; the chart scrolls inside its box", () => {
    expect(weekLabel("2026-08-24")).toBe("Aug 24");
    const eight = themesSection(themes("ready"), rp());
    const q = themesSection(themes("ready"), rp({ ui: ui({ themesRange: "quarter" }) }));
    const cols = (h: string) => Number(h.match(/grid-template-columns:var\(--lane-w,190px\) repeat\((\d+),/)![1]);
    expect(cols(eight)).toBe(8);
    expect(cols(q)).toBe(13);
    expect(eight).toContain("overflow-x:auto");
    expect(eight).toMatch(/class="repo-themes-chart" style="min-width:\d+px/);
    expect(text(eight)).toContain(weekLabel(themes("ready")["8w"].weeks[0]));
  });
  it("empty: the 15-PR sentence; capped: the last chart and the allowance line", () => {
    expect(text(themesSection(themes("empty"), rp()))).toContain("Themes appear once this repo has 15 merged pull requests.");
    const c = text(themesSection(themes("capped"), rp()));
    expect(c).toContain("Monthly AI allowance used; themes resume Nov 1. Upgrade to Pro");
    expect(c).toContain("Multi-org and GitHub App");
  });
  it("proposed (admin): 'Trov suggests these themes', each with Accept / Rename / Remove", () => {
    const h = themesSection(themes("proposed"), rp());
    expect(h).toContain('data-ai-state="proposed"');
    const block = h.slice(h.indexOf('id="repo-themes-proposed"'), h.indexOf("repo-themes-scroll"));
    expect(text(block)).toContain("Trov suggests these themes");
    expect((block.match(/data-act="aiAccept"/g) ?? []).length).toBe(6);
    expect((block.match(/data-act="aiRenameOpen"/g) ?? []).length).toBe(6);
    expect((block.match(/>Remove<\/button>/g) ?? []).length).toBe(6);
    expect(block).toContain('data-act="aiAccept" data-arg="910"');
    expect(block).not.toContain("Waiting for an admin");
  });
  it("proposed (member): no buttons, 'Waiting for an admin to accept themes'", () => {
    const h = themesSection(themes("proposed"), rp({ admin: false }));
    expect(text(h)).toContain("Waiting for an admin to accept themes");
    expect(h).not.toContain("aiAccept");
    expect(h).not.toContain("aiRenameOpen");
  });
  it("Rename is an inline labelled field; a 409 not_available says 'Not available yet'", () => {
    const h = themesSection(themes("proposed"), rp({ ui: ui({ rename: { id: 911, draft: "Tickets" } }) }));
    expect(h).toMatch(/<label for="ai-rename-911" class="cnpy-sr">New name for Tickets and sprints<\/label>/);
    expect(h).toMatch(/<input id="ai-rename-911" data-act="aiRenameDraft" data-arg="911"[^>]*value="Tickets"/);
    expect(h).toContain('data-act="aiRenameSave" data-arg="911"');
    const na = themesSection(themes("proposed"), rp({ ui: ui({ unavailable: [912] }) }));
    const chip = na.slice(na.indexOf('data-ai-chip="theme-912"'));
    expect(chip.slice(0, chip.indexOf("</li>"))).toContain("Not available yet");
  });
  it("is Planning's first section, above the panel", () => {
    const data = { ...repoSample(NOW.getTime()), themes: themes("ready") };
    const html = repoView({ tab: "planning", range: "7d", driftOpen: false, repo: { status: "ok", data }, fetchedAt: NOW.getTime(), sample: false, admin: true, poll: null, productEnv: null, ai: rp() });
    expect(html.indexOf('data-ai="themes"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-ai="themes"')).toBeLessThan(html.indexOf("repo-panel"));
  });
});

// ── Feed ────────────────────────────────────────────────────────────────────

describe("Feed — entries written by Trov", () => {
  const agent: FeedRow = { id: 5, author: "andres", summary: "Decision: hosting connections stay read-only", brief: "Read-only.", body: null, artifacts: null, created_at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString() };
  const rows = (): FeedRow[] => {
    const [a, b] = feedFixtures(NOW);
    return [a, agent, b];
  };
  const feed = (o: Partial<AppState> = {}) => app({ screen: "feed", feedView: "reading", feed: { status: "ok", data: rows() }, feedAuthors: ["trov", "andres"], ...o });

  it("an entry Trov wrote: the AI mark as its avatar, 'Trov', 'for @andres', its sources and Wrong?", () => {
    const html = render(feed());
    const card = html.slice(html.indexOf('data-feed-id="990001"'));
    const one = card.slice(0, card.indexOf('data-feed-id="990002"'));
    expect(one).toContain("cnpy-ai-av");
    expect(one).toContain(`d="${TROV_MARK_PATH}"`);
    expect(text(one)).toContain("Trov for @andres");
    expect(one).toContain('data-act="openPerson" data-arg="andres"');
    expect(text(one)).toContain("From #173 , 65b9f1f , a1c04e2 and 2 more");
    expect(one).toContain("Written by Trov from #173, 65b9f1f, a1c04e2 and 2 more. Not official; check the sources.");
    expect(one).toContain('data-act="aiWrong"');
    expect(one).not.toContain("cnpy-issuechip");
  });
  it("the Source switch sits beside the view switch, and filters on origin", () => {
    const html = render(feed());
    expect(html).toContain('data-seg="feed-source"');
    expect(html.indexOf('data-seg="feed-source"')).toBeLessThan(html.indexOf('data-seg="feed-view"'));
    const ids = (s: AppState) => feedShown(s).map((e) => e.id);
    expect(ids(feed())).toEqual([990001, 5, 990002]);
    expect(ids(feed({ ai: ui({ feedSource: "trov" }) }))).toEqual([990001, 990002]);
    expect(ids(feed({ ai: ui({ feedSource: "agents" }) }))).toEqual([5]);
    // An entry whose `ai.origin` is "agent" counts as an agent's.
    const tagged = feed({ feed: { status: "ok", data: [{ ...agent, ai: { origin: "agent", subject: null, sources: [], moreCount: 0, generatedAt: null, model: null } }] } });
    expect(feedShown({ ...tagged, ai: ui({ feedSource: "agents" }) }).map((e) => e.id)).toEqual([5]);
  });
  it("the one-time note sits above the first Trov entry, links to Org settings › AI, and goes on 'Got it'", () => {
    const html = render(feed());
    expect(text(html)).toContain(FEED_AI_NOTE);
    expect(html.indexOf("cnpy-ai-note")).toBeLessThan(html.indexOf('data-feed-id="990001"'));
    expect(html).toContain('data-act="orgGo" data-arg="ai"');
    expect(html).toContain('data-act="aiNoteGotIt"');
    expect((html.match(/cnpy-ai-note/g) ?? []).length).toBe(1);
    expect(render(feed({ ai: ui({ noteSeen: ["Andres"] }) }))).not.toContain("cnpy-ai-note");
    // Above the first Trov entry ON SCREEN: with Agents picked, there is none, so no note.
    expect(render(feed({ ai: ui({ feedSource: "agents" }) }))).not.toContain("cnpy-ai-note");
  });
  it("Source = Trov with no Trov entry on the page says so (Q27)", () => {
    const tagged = { ...agent, ai: { origin: "agent" as const, subject: null, sources: [], moreCount: 0, generatedAt: null, model: null } };
    const html = render(feed({ feed: { status: "ok", data: [tagged] }, ai: ui({ feedSource: "trov" }) }));
    expect(text(html)).toContain(FEED_NO_TROV);
    expect(text(html)).not.toContain("No entries match this filter.");
    // Agents or All with nothing shown keep the filter's words.
    expect(text(render(feed({ feed: { status: "ok", data: [rows()[0]] }, ai: ui({ feedSource: "agents" }) })))).toContain("No entries match this filter.");
  });
  it("My Work › Your sessions draws a digest Trov wrote about me with the AI mark (Q30); my own entries as before", () => {
    const html = sessionsTile([
      { id: 1, summaryHtml: "Shipped: hosting", brief: null, at: NOW.toISOString(), trov: true },
      { id: 2, summaryHtml: "Decision: read-only", brief: null, at: NOW.toISOString() },
    ], "ok", [], 6);
    const rowsOf = html.split('class="mw-row"');
    expect(rowsOf[1]).toContain('data-ai="session"');
    expect(rowsOf[1]).toContain(AI_TIP.session);
    expect(rowsOf[2]).not.toContain('data-ai="session"');
  });
  it("a Trov entry about a deleted account says \"Deleted user\" as plain text, never a link (Q31)", () => {
    const [a] = feedFixtures(NOW);
    const gone = { ...a, ai: { ...a.ai!, subject: "deleted-x7k2" } };
    const persons = { status: "ok" as const, data: [...PERSONS, { handle: "deleted-x7k2", name: "Deleted user", color: "sky" as const, avatar_url: null, role: null }] };
    const html = render(feed({ feed: { status: "ok", data: [gone] }, persons }));
    const card = html.slice(html.indexOf(`data-feed-id="${a.id}"`));
    expect(text(card)).toContain("Trov for Deleted user");
    expect(card).not.toContain('data-arg="deleted-x7k2"');
    expect(card).not.toContain("@deleted-x7k2");
  });
  it("Wrong? hides the entry for this person", () => {
    const html = render(feed({ ai: ui({ hidden: ["feed:990001"] }) }));
    expect(html).not.toContain('data-feed-id="990001"');
    expect(html).toContain('data-feed-id="990002"');
  });
  it("no entry carries `ai`: no Source switch, no note", () => {
    const html = render(feed({ feed: { status: "ok", data: [agent] } }));
    expect(html).not.toContain('data-seg="feed-source"');
    expect(html).not.toContain("cnpy-ai-note");
  });
});

// ── Org settings › AI ───────────────────────────────────────────────────────

describe("Org settings › AI", () => {
  const org = { slug: "trov", name: "Trov", role: "admin" as const };
  const use = (used: number, cap: number | null, resumesOn: string | null = null) => ({ used, cap, resumesOn });
  const settings = (o: Partial<AiSettings> = {}): AiSettings => ({
    enabled: true, canEdit: true, eligibility: "ok",
    allowances: { ai_summaries: use(212, 3000), ai_runs: use(1212, 3000), jev_checks: use(40, 10000), ai_chat: use(830, 2500) },
    chatAuto: true, keys: { anthropic: true, typesafe: true }, planEnded: null, sends: [...AI_SENDS], neverSent: AI_NEVER_SENT, ...o,
  });
  const tab = (a: AiSettings | null, status: "ok" | "loading" | "error" = "ok", saving = false) => aiTab(org, { status, data: a }, saving);

  it("an admin gets both switches — the AI switch and Ask Trov's Auto; a member reads their state as words", () => {
    const admin = tab(settings());
    expect(admin).toMatch(/<button data-act="orgAiToggle" role="switch" aria-checked="true" aria-label="Trov(&#39;|')s AI for this organization"/);
    expect(admin).toMatch(/<button data-act="orgAiChatAutoToggle" role="switch" aria-checked="true" aria-label="Auto mode in Ask Trov for this organization"/);
    expect(tab(settings({ chatAuto: false }))).toMatch(/data-act="orgAiChatAutoToggle" role="switch" aria-checked="false"/);
    expect(tab(settings({ chatAuto: false }))).toContain('data-ai-chat-auto="off"');
    const member = tab(settings({ canEdit: false, enabled: false, chatAuto: false }));
    expect(member).not.toContain('role="switch"');
    expect(text(member)).toContain("Off");
    expect(text(member)).toContain("Auto mode in Ask Trov");
    expect(text(member)).toContain("Only an admin or an owner can change this.");
    // e2e EV-OA-admin-K: held while the write is out WITHOUT `disabled` — a disabled button drops the keyboard's
    // focus to <body> the moment Space or Enter toggles it; the toggle's own guard refuses a second press.
    const saving = tab(settings(), "ok", true);
    expect(saving).toMatch(/role="switch" aria-checked="true"[^>]* aria-disabled="true" aria-busy="true"/);
    expect(saving).not.toMatch(/role="switch"[^>]* disabled[ >]/);
  });
  it("all four allowances with this month's use, in order; unlimited when the plan has no cap; the resume date when one is used up", () => {
    const html = tab(settings());
    expect([...html.matchAll(/data-ai-allowance="([a-z_]+)"/g)].map((m) => m[1])).toEqual(["ai_summaries", "ai_runs", "jev_checks", "ai_chat"]);
    const t = text(html);
    for (const line of ["212 of 3,000 summaries this month", "1,212 of 3,000 runs this month", "40 of 10,000 checks this month", "830 of 2,500 questions this month"]) expect(t).toContain(line);
    for (const name of ["Summaries", "Written by Trov", "Sift", "Ask Trov"]) expect(t).toContain(name);
    expect(t).toContain("A Thinking question counts as 5");
    expect(html.match(/role="meter"/g)?.length).toBe(4);
    expect(allowanceLine("ai_runs", use(4, null))).toBe("4 runs this month (unlimited)");
    expect(allowanceLine("jev_checks", use(1, null))).toBe("1 check this month (unlimited)");
    const unlimited = tab(settings({ allowances: { ai_summaries: use(1, null), ai_runs: use(9, null), jev_checks: use(0, null), ai_chat: use(0, null) } }));
    expect(unlimited).not.toContain('role="meter"');
    const capped = text(tab(settings({ eligibility: "capped", allowances: { ...settings().allowances, ai_runs: use(3000, 3000, "2026-11-01"), ai_chat: use(2500, 2500, "2026-11-01") } })));
    expect(capped).toContain("Used up for this month: Trov writes nothing new until Nov 1.");
    expect(capped).toContain("Used up for this month: Ask Trov pauses until Nov 1.");
    expect(capped).not.toContain("excerpt until"); // summaries are not used up
  });
  it("ONE cap test (Q11, `capReached`: used >= cap): 99.6% is neither a full meter nor used up; the cap itself is both", () => {
    const meterOf = (html: string, key: string) => html.match(new RegExp(`data-ai-allowance="${key}"[\\s\\S]*?data-meter="(\\w+)"[\\s\\S]*?<span style="width:(\\d+)%`))!.slice(1);
    const almost = tab(settings({ allowances: { ...settings().allowances, ai_runs: use(2988, 3000, null) } }));
    expect(meterOf(almost, "ai_runs")).toEqual(["ok", "99"]);
    expect(text(almost)).not.toContain("Used up for this month: Trov writes nothing new");
    const full = tab(settings({ allowances: { ...settings().allowances, ai_runs: use(3000, 3000, "2026-11-01") } }));
    expect(meterOf(full, "ai_runs")).toEqual(["full", "100"]);
    expect(text(full)).toContain("Used up for this month: Trov writes nothing new until Nov 1.");
    expect([capReached(2999, 3000), capReached(3000, 3000), capReached(3001, 3000), capReached(5, null)]).toEqual([false, true, true, false]);
    expect([meterPct(2988, 3000), meterPct(2999, 3000), meterPct(3000, 3000), meterPct(1, null)]).toEqual([99, 99, 100, 0]);
  });
  it("what is sent names BOTH providers — Anthropic and TypeSafe AI — and what each receives, with what is never sent; the model is Sift, never named", () => {
    const html = tab(settings());
    const t = text(html);
    expect(t).toContain("What is sent");
    expect(html).toContain('data-ai-sends="Anthropic"');
    expect(html).toContain('data-ai-sends="TypeSafe AI"');
    expect(t).toContain("To Anthropic");
    expect(t).toContain("To TypeSafe AI");
    expect(t).toContain("Pull request and issue titles and descriptions (up to 8,000 characters each)");
    expect(t).toContain("For summaries");
    expect(t).toContain("the title and first 400 characters of each feed entry, doc or decision that may fit it");
    expect(t).toContain("For Sift");
    expect(t).toContain(AI_NEVER_SENT);
    expect(t).not.toMatch(/\bJev\b/);
    expect(html).not.toMatch(/\bJev\b/);
  });
  it("what is sent is HELD to the approved Privacy rows (summaries, Sift) while the AI passages are DRAFT — and lists every one once they are (e2e OA-1 / LG-2; owner ruling 2026-10-16)", () => {
    const t = text(tab(settings()));
    // Held: only what the Privacy Policy states as final. The flag and the full list: test/render.legal.test.ts.
    expect(AI_LEGAL_DRAFT).toBe(true);
    for (const line of ["For summaries", "For Sift"]) expect(t).toContain(line);
    for (const line of ["For Ask Trov", "For filters typed in plain words", "For notes, briefs, the weekly email", "For sorting and checking items"]) {
      expect(t).not.toContain(line);
    }
    // Once approved, the screen renders every line the Privacy Policy's provider table names.
    const full = text(tab(settings({ sends: [...AI_SENDS_ALL] })));
    for (const line of ["For summaries", "For Ask Trov", "For filters typed in plain words", "For notes, briefs, the weekly email", "For Sift", "For sorting and checking items"]) {
      expect(full).toContain(line);
    }
    const sharing = PRIVACY.sections.find((s) => s.id === "sharing")!.body.join(" ");
    const rows = (sharing.match(/<td>(Anthropic|TypeSafe AI)<\/td>/g) ?? []).length;
    expect(AI_SENDS_ALL.length).toBe(rows);
  });
  it("no key on this Trov: said as a fact", () => {
    expect(text(tab(settings({ eligibility: "no_key", keys: { anthropic: false, typesafe: true } })))).toContain("This Trov has no Anthropic key");
  });
  // Q8 (owner ruling 2026-10-16): the TypeSafe key was said only on Tags; now each provider has its own status.
  it("each provider's key has its own status: Anthropic and TypeSafe AI, set (a plain fact) or missing (a mark and what it stops)", () => {
    const both = tab(settings());
    expect([...both.matchAll(/data-ai-key="([a-z]+)" data-set="(\d)"/g)].map((m) => [m[1], m[2]])).toEqual([["anthropic", "1"], ["typesafe", "1"]]);
    expect(text(both)).toContain("Providers");
    expect(text(both).match(/Key set/g)?.length).toBe(2);
    expect(both).not.toContain("No key");
    const noSift = tab(settings({ keys: { anthropic: true, typesafe: false } }));
    expect(text(noSift)).toContain("This Trov has no TypeSafe AI key, so Sift tags, sorts and checks nothing whatever the switch says.");
    expect(noSift).toMatch(/data-ai-key="typesafe" data-set="0"[\s\S]*No key/);
    expect(noSift.slice(noSift.indexOf('data-ai-key="anthropic"'), noSift.indexOf('data-ai-key="typesafe"'))).not.toContain("No key");
    expect(text(noSift)).not.toContain("no Anthropic key");
    const neither = text(tab(settings({ eligibility: "no_key", keys: { anthropic: false, typesafe: false } })));
    expect(neither).toContain("This Trov has no Anthropic key");
    expect(neither).toContain("This Trov has no TypeSafe AI key");
    expect(neither).not.toMatch(/\bJev\b/);
  });
  // Q10 (owner ruling 2026-10-16): a canceled plan read as `capped` with no sentence and no "Used up" line.
  it("an ended plan says so under the switch, with the way to the plan (Org settings › General)", () => {
    const html = tab(settings({ eligibility: "capped", planEnded: "Pro" }));
    expect(text(html).replace(/&#39;/g, "'")).toContain("This organization's Pro plan has ended, so Trov's AI is paused until it is renewed.");
    expect(html).toMatch(/data-ai-plan-ended[\s\S]*data-act="orgGo" data-arg="general"[^>]*>Plan and billing/);
    expect(tab(settings())).not.toContain("data-ai-plan-ended");
  });
  it("not read yet is a skeleton; a failed read says so", () => {
    expect(tab(null, "loading")).toContain("aria-busy");
    expect(text(tab(null, "error"))).toContain("Couldn't load the AI settings");
  });
  it("is a tab every member sees (`#org/ai`)", () => {
    const s = app({ screen: "org", org: { ...initialState().org, tab: "ai", slug: "trov", ai: { status: "ok", data: settings({ canEdit: false }) } } }, "member");
    const html = render(s);
    expect(html).toContain('id="org-tab-ai"');
    expect(text(html)).toContain("To TypeSafe AI");
  });
});

// ── Platform › Usage ────────────────────────────────────────────────────────

describe("Platform › Usage — AI runs and tokens", () => {
  const ai = { runs: 120, failed: 3, capped: 1, tokensIn: 48_000, tokensOut: 9_100, tokensCached: 30_000 };
  const org = (o: Partial<OrgUsage> = {}): OrgUsage => ({
    slug: "acme", name: "Acme", status: "active", created_at: "2026-09-01T10:00:00.000Z", last_activity_at: null,
    sizes: { members: 1, docs: 0, feed_entries: 0, tickets_open: 0, tickets_total: 0, sprints: 0, prompts: 0, handoffs: 0, artifacts: 0, artifact_bytes: 0, repo_events: 0, mcp_tokens: 0, oauth_grants: 0 },
    activity: { api_requests: 5, api_reads: 5, api_writes: 0, mcp_requests: 0, mcp_tool_calls: 0, active_people: 1, created: { feed_entries: 0, tickets: 0, doc_versions: 0, sprints: 0, prompts: 0, handoffs: 0, artifacts: 0 }, emails_sent: 0, top_tools: [] },
    series: [], summaries: { attempted: 0, succeeded: 0, failed: 0, capped: 0, fell_back: 0, chars_in: 0, chars_out: 0, tokens_in: 0, tokens_out: 0, month_used: 0, cap: 300 }, ...o,
  });
  const report = (orgs: OrgUsage[], withAi: boolean): PlatformUsageResponse => ({
    days: 7, since: "2026-10-08", until: "2026-10-14", generated_at: NOW.toISOString(), summaries_enabled: true,
    summaries: { attempted: 0, succeeded: 0, failed: 0, capped: 0, fell_back: 0, chars_in: 0, chars_out: 0, tokens_in: 0, tokens_out: 0 },
    totals: { orgs: orgs.length, suspended_orgs: 0, persons: 1, last_activity_at: null, sizes: orgs[0].sizes, activity: orgs[0].activity, series: [] },
    orgs, ...(withAi ? { ai } : {}),
  });
  it("the totals strip and an organization's row show AI runs and tokens when the read carries them", () => {
    const html = usageView({ status: "ok", usage: report([org({ ai })], true), days: 7, open: "acme" });
    const totals = html.slice(html.indexOf('data-usage-ai="totals"'));
    expect(text(totals.slice(0, totals.indexOf("</div>")))).toContain("AI runs Runs 120 Failed 3 Capped 1 Tokens in 48.0K Tokens out 9,100 Cached 30.0K last 7 days, all organizations");
    expect(html).toContain('data-usage-ai style');
    expect(text(orgUsageBlock(org({ ai }), 7))).toContain("AI runs Runs 120");
  });
  // Q7 (owner ruling 2026-10-16): with a TypeSafe key and no Anthropic key, Sift's figures still show.
  it("only Sift's figures (no Anthropic key): the line is \"Sift\", with its checks and tokens — no runs, no zeros", () => {
    const sift = { jevChecks: 1520, jevTokensIn: 3000, jevTokensOut: 40 };
    const r = report([org({ ai: sift })], false);
    const html = usageView({ status: "ok", usage: { ...r, ai: sift }, days: 7, open: "acme" });
    const totals = html.slice(html.indexOf('data-usage-ai="totals"'));
    expect(text(totals.slice(0, totals.indexOf("</div>")))).toContain("> Sift Sift checks 1,520 Sift tokens in 3,000 Sift tokens out 40 last 7 days, all organizations");
    expect(text(orgUsageBlock(org({ ai: sift }), 7))).toContain("Sift Sift checks 1,520");
    expect(html).not.toContain("AI runs");
    expect(html).not.toMatch(/Runs 0|Failed 0/);
  });

  it("absent `ai` adds nothing — never a line of zeros", () => {
    const html = usageView({ status: "ok", usage: report([org()], false), days: 7, open: "acme" });
    expect(html).not.toContain("data-usage-ai");
    expect(html).not.toContain("AI runs");
    expect(orgUsageBlock(org(), 7)).not.toContain("AI runs");
  });
});

describe("the preview fixtures drive every screen without a stray undefined", () => {
  it("each mode renders My Work, Repo and the Feed cleanly", () => {
    for (const mode of ["ready", "empty", "capped", "proposed"] as const) {
      const f = aiPreviewFixtures(mode, NOW);
      const mwHtml = render(app({ screen: "mywork", mywork: { status: "ok", data: dash({ brief: f.brief }) } }));
      const data = { ...repoSample(NOW.getTime()), state: f.repoState, themes: f.themes };
      const repo = ["overview", "planning"].map((repoTab) => render(app({ screen: "repo", repoTab: repoTab as "overview", repo: { status: "ok", data } })));
      const feedHtml = render(app({ screen: "feed", feed: { status: "ok", data: f.feed } }));
      for (const h of [mwHtml, ...repo, feedHtml]) expect(h, mode).not.toMatch(/undefined|NaN|\[object/);
    }
  });
});

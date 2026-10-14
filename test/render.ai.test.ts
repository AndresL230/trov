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
import { render, initialState, feedShown, FEED_AI_NOTE, type AppState } from "../web/src/render";
import { briefTile } from "../web/src/mywork";
import { repoStateSection, themesSection, bandHeight, weekLabel, type RepoAiProps } from "../web/src/repo-ai";
import { repoView, type RepoProps } from "../web/src/repo";
import { repoSample } from "../web/src/repo-sample";
import {
  AI_EMPTY, initialAiUi, aiCite, aiCapped, aiDay, aiSuggestionChip, aiWrongBtn, aiFeedback, aiFromLine, type AiUi,
} from "../web/src/ai-ui";
import { parseFeedbackArg } from "../web/src/ai-actions";
import { aiMark } from "../web/src/marks";
import { aiTab, aiRunsLine } from "../web/src/org-ai";
import { usageView, orgUsageBlock } from "../web/src/platform-usage";
import { briefFixture, repoStateFixture, themesFixture, feedFixtures, aiPreviewFixtures } from "@shared/ai-fixtures";
import { AI_NEVER_SENT, AI_SENDS, type AiSettings, type AiThemeRange, type AiThemes } from "@shared/ai-core";
import type { DashboardData } from "@shared/dashboard";
import type { FeedRow } from "@shared/rows";
import type { OrgUsage, PlatformUsageResponse } from "@shared/orgs";

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
  it("the AI mark is the mock's pennant in the accent, an SVG element with its tooltip — never a pill", () => {
    const m = aiMark(12, "Written by Trov from x. Not official; check the sources.");
    expect(m).toContain('d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z"');
    expect(m).toContain('viewBox="0 0 24 24"');
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
  it("Wrong? carries the item it is about, and only a well-formed body is ever sent back", () => {
    const b = aiFeedback("feed", "990001", "feed", "claude-haiku-5-5");
    const btn = aiWrongBtn(b);
    expect(btn).toContain('data-act="aiWrong"');
    expect(btn).toContain(">Wrong?</button>");
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
    expect(h).toContain('d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z"');
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

  it("ready: the first card — header, byline, Wrong?, then Now / Recently / Next with their sources", () => {
    const html = mw("ready");
    const labels = [...html.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
    expect(labels[0]).toBe("Your brief");
    expect(labels.slice(1)).toEqual(["Tickets for you", "Needs your review", "Your sessions", "Repo monitor", "Your library"]);
    const card = html.slice(html.indexOf('data-mw="brief"'), html.indexOf('data-mw="tickets"'));
    const t = text(card);
    expect(t).toContain("Your brief");
    expect(t).toContain("Written by Trov, 12m ago");
    expect(card).toContain("Written by Trov from your sessions, pull requests, tickets and handoffs. Not official; check the sources.");
    expect(card).toContain(">Wrong?</button>");
    for (const w of ["Now", "Recently", "Next", "feat/hosting-screens", "CI run 4812", "#173", "#172", "#171"]) expect(t).toContain(w);
  });
  it("ready: each Next row is a state mark, the item's linked title and a muted why", () => {
    const card = briefTile(briefFixture("ready", NOW));
    const rows = card.split('class="mw-brief-next"').slice(1);
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
  it("empty: the mock's sentence, no grid, no Wrong?", () => {
    const card = briefTile(briefFixture("empty", NOW));
    expect(text(card)).toContain(AI_EMPTY.brief);
    expect(card).not.toContain("mw-brief-grid");
    expect(card).not.toContain(">Wrong?<");
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

// ── Repo › Overview › State ─────────────────────────────────────────────────

describe("Repo › Overview › State", () => {
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
    expect(h).toContain(">Wrong?</button>");
    expect(h).toContain("repo-state-cols");
  });
  it("omits 'from N events' when the count is unknown — never a guessed 0", () => {
    const h = repoStateSection({ ...repoStateFixture("ready", NOW), eventCount: null }, rp());
    expect(text(h)).toContain("Written by Trov, 2h ago");
    expect(h).not.toContain("0 events");
  });
  it("empty: the mock's sentence; capped: the headline and 'this state is from <day> and resumes <day>'", () => {
    expect(text(repoStateSection(repoStateFixture("empty", NOW), rp()))).toContain(AI_EMPTY.state);
    const c = text(repoStateSection(repoStateFixture("capped", NOW), rp()));
    expect(c).toContain("Release 0.30 is live");
    expect(c).toContain("Monthly AI allowance used; this state is from Oct 5 and resumes Nov 1. Upgrade to Pro");
  });
  it("is the Overview's first section, above the panel — only with `state` on a live dashboard", () => {
    const data = { ...repoSample(NOW.getTime()), state: repoStateFixture("ready", NOW) };
    const props = (o: Partial<RepoProps> = {}): RepoProps => ({ tab: "overview", range: "7d", driftOpen: false, repo: { status: "ok", data }, fetchedAt: NOW.getTime(), sample: false, admin: true, poll: null, productEnv: null, ai: rp(), ...o });
    const html = repoView(props());
    expect(html.indexOf('data-ai="repo_state"')).toBeGreaterThan(-1);
    expect(html.indexOf('data-ai="repo_state"')).toBeLessThan(html.indexOf("repo-panel"));
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
    const cols = (h: string) => Number(h.match(/grid-template-columns:190px repeat\((\d+),/)![1]);
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
    expect(block).toContain('data-act="aiAccept" data-arg="900"');
    expect(block).not.toContain("Waiting for an admin");
  });
  it("proposed (member): no buttons, 'Waiting for an admin to accept themes'", () => {
    const h = themesSection(themes("proposed"), rp({ admin: false }));
    expect(text(h)).toContain("Waiting for an admin to accept themes");
    expect(h).not.toContain("aiAccept");
    expect(h).not.toContain("aiRenameOpen");
  });
  it("Rename is an inline labelled field; a 409 not_available says 'Not available yet'", () => {
    const h = themesSection(themes("proposed"), rp({ ui: ui({ rename: { id: 901, draft: "Tickets" } }) }));
    expect(h).toMatch(/<label for="ai-rename-901" class="cnpy-sr">New name for Tickets and sprints<\/label>/);
    expect(h).toMatch(/<input id="ai-rename-901" data-act="aiRenameDraft" data-arg="901"[^>]*value="Tickets"/);
    expect(h).toContain('data-act="aiRenameSave" data-arg="901"');
    const na = themesSection(themes("proposed"), rp({ ui: ui({ unavailable: [902] }) }));
    const chip = na.slice(na.indexOf('data-ai-chip="theme-902"'));
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
    expect(one).toContain('d="M4 4h16v6l-4 4h-4v6H8v-6L4 10z"');
    expect(text(one)).toContain("Trov for @andres");
    expect(one).toContain('data-act="openPerson" data-arg="andres"');
    expect(text(one)).toContain("From #173 , 65b9f1f , a1c04e2 and 2 more");
    expect(one).toContain("Written by Trov from #173, 65b9f1f, a1c04e2 and 2 more. Not official; check the sources.");
    expect(one).toContain(">Wrong?</button>");
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
  const settings = (o: Partial<AiSettings> = {}): AiSettings => ({ enabled: true, canEdit: true, eligibility: "ok", runs: { used: 1212, cap: 3000, resumesOn: null }, sends: [...AI_SENDS], neverSent: AI_NEVER_SENT, ...o });
  const tab = (a: AiSettings | null, status: "ok" | "loading" | "error" = "ok", saving = false) => aiTab(org, { status, data: a }, saving);

  it("an admin gets the switch; a member reads its state as words", () => {
    const admin = tab(settings());
    expect(admin).toMatch(/<button data-act="orgAiToggle" role="switch" aria-checked="true" aria-label="Trov(&#39;|')s AI for this organization"/);
    const member = tab(settings({ canEdit: false, enabled: false }));
    expect(member).not.toContain('role="switch"');
    expect(text(member)).toContain("Off");
    expect(text(member)).toContain("Only an admin or an owner can change this.");
    expect(tab(settings(), "ok", true)).toMatch(/role="switch" aria-checked="true"[^>]* disabled aria-busy="true"/);
  });
  it("this month's runs against the allowance; unlimited when the plan has no cap; the resume date when used up", () => {
    expect(text(tab(settings()))).toContain("1,212 of 3,000 AI runs this month");
    expect(tab(settings())).toContain('role="meter"');
    expect(aiRunsLine({ used: 4, cap: null, resumesOn: null })).toBe("4 AI runs this month (unlimited)");
    expect(tab(settings({ runs: { used: 9, cap: null, resumesOn: null } }))).not.toContain('role="meter"');
    const capped = text(tab(settings({ eligibility: "capped", runs: { used: 3000, cap: 3000, resumesOn: "2026-11-01" } })));
    expect(capped).toContain("Monthly AI allowance used; Trov writes again on Nov 1.");
  });
  it("what is sent to Anthropic is a list, with what is never sent", () => {
    const t = text(tab(settings()));
    expect(t).toContain("What is sent to Anthropic");
    expect(t).toContain("Pull request and issue titles and descriptions (up to 8,000 characters each)");
    expect(t).toContain("For summaries");
    expect(t).toContain(AI_NEVER_SENT);
  });
  it("no key on this Trov: said as a fact", () => {
    expect(text(tab(settings({ eligibility: "no_key" })))).toContain("This Trov has no Anthropic key");
  });
  it("not read yet is a skeleton; a failed read says so", () => {
    expect(tab(null, "loading")).toContain("aria-busy");
    expect(text(tab(null, "error"))).toContain("Couldn't load the AI settings");
  });
  it("is a tab every member sees (`#org/ai`)", () => {
    const s = app({ screen: "org", org: { ...initialState().org, tab: "ai", slug: "trov", ai: { status: "ok", data: settings({ canEdit: false }) } } }, "member");
    const html = render(s);
    expect(html).toContain('id="org-tab-ai"');
    expect(text(html)).toContain("What is sent to Anthropic");
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

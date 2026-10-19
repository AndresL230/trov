/**
 * Home render tests — the design `Trov Overview v2` (web/src/home.ts), composed by home-view.ts from the reads the
 * app already has plus `GET /home`. The page's order never changes; Needs attention puts what is failing first and a
 * member's calm rows carry no action; a figure the server could not count is "—"; the inline answer shows Ask's own
 * byline, sources and Wrong?.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => `<span class="mock-mdi">${s.replace(/</g, "&lt;")}</span>`,
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import { initialState, type AppState } from "../web/src/render";
import { homePage, homeAnswerView } from "../web/src/home";
import { homeProps, initialHomeUi, homeHeadSettled } from "../web/src/home-view";
import { navKeyOf } from "../web/src/sidebar";
import { HOME_DAYS, type HomeData, type HomeDay } from "@shared/home-core";
import type { RepoDashboard } from "@shared/repo";

const today = new Date();
const ymd = (d: Date) => d.toISOString().slice(0, 10);
function days(fill: (i: number) => Partial<HomeDay> = () => ({})): HomeDay[] {
  return Array.from({ length: HOME_DAYS }, (_, i) => {
    const d = new Date(today.getTime() - (HOME_DAYS - 1 - i) * 86_400_000);
    return { date: ymd(d), tickets: 0, handoffs: 0, docs: 0, sessions: 0, ...fill(i) };
  });
}
function home(o: Partial<HomeData> = {}): HomeData {
  return { days: days(), team: [], repos: [], backlog: 0, triage: { count: 0, oldest: null }, ...o };
}
function state(o: Partial<AppState> = {}, role: "owner" | "member" = "owner"): AppState {
  const s = initialState();
  return {
    ...s, view: "app", screen: "home", orgSlug: "saplinglearn",
    me: { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null } as AppState["me"],
    myOrgs: { status: "ok", data: { orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role }] } } as unknown as AppState["myOrgs"],
    badges: { proposals: 0, decisions: 0, unplaced: 0 },
    // The head has settled (homeHeadSettled): these tests are about what it says, the head's own test about when.
    home: { ...initialHomeUi(), data: { status: "ok", data: home() }, feed: { status: "ok", data: [] }, headReady: true },
    ...o,
  };
}
const page = (s: AppState) => homePage(homeProps(s, false, ""));
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");

describe("Home — the page", () => {
  it("is its own screen, lighting Home in the sidebar", () => {
    expect(navKeyOf("home")).toBe("home");
  });

  it("draws the design's order: head, bar, Repositories · Roadmap · For you, Activity, Latest beside Team", () => {
    const html = page(state());
    expect(html.indexOf('data-field="homeQ"')).toBeGreaterThan(html.indexOf('class="hm-h'));
    expect(html.indexOf('data-field="homeQ"')).toBeLessThan(html.indexOf("Repositories"));
    const t = text(html);
    const order = ["Repositories", "Roadmap", "For you", "Activity", "Tickets done", "Handoffs claimed", "Docs promoted", "Sessions recorded", "Latest", "Team"];
    let at = -1;
    for (const w of order) { const i = t.indexOf(w, at + 1); expect(i, w).toBeGreaterThan(at); at = i; }
  });

  it("shows the head as skeletons until every read behind it lands, then holds it through a refresh", () => {
    const s = state();
    s.home.headReady = false;
    const pending = page(s);
    expect(pending).toContain("hm-h-pending");
    expect(pending).toContain("hm-status-pending");
    expect(pending).not.toMatch(/<h2 class="hm-h/);
    expect(homeHeadSettled(s)).toBe(false);

    const ok = <T,>(l: { data: T }) => ({ status: "ok" as const, data: l.data });
    const landed: AppState = { ...s, repo: ok(s.repo), sprints: ok(s.sprints), handoffs: ok(s.handoffs), mywork: ok(s.mywork), orgMe: { status: "error", data: s.orgMe.data, error: "x" },
      home: { ...s.home, github: ok(s.home.github) } };
    expect(homeHeadSettled(landed)).toBe(true);
    const html = page(landed);
    expect(html).toMatch(/<h2 class="hm-h/);
    expect(html).not.toContain("hm-status-pending");

    // A refresh marks the reads loading again; once ready, the head stays drawn.
    const refreshing: AppState = { ...landed, repo: { status: "loading", data: landed.repo.data }, home: { ...landed.home, headReady: true } };
    expect(homeHeadSettled(refreshing)).toBe(false);
    expect(page(refreshing)).not.toContain("hm-h-pending");
  });

  it("with nothing waiting, the status line is the all-clear and has nothing to open", () => {
    const html = page(state({ orgMe: { status: "ok", data: { repos: { primary: "acme/app", all: ["acme/app"] } } as never } }));
    expect(text(html)).toContain("All clear · nothing needs you");
    expect(html).toMatch(/class="hm-status" disabled/);
  });

  it("puts a failing deploy first: the status names it and counts what needs the viewer", () => {
    const facts = { repo: "acme/app", attention: [{ kind: "failed", app: "api", env: "production", refs: {} }], ci: [], parts: [], allApps: [], envs: [] };
    const s = state({ repo: { status: "ok", data: { facts } as unknown as RepoDashboard }, badges: { proposals: 2, decisions: 1, unplaced: 0 } });
    s.home.attnOpen = true;
    const html = page(s);
    expect(text(html)).toContain("Deploy of api in production failed · 2 need you");
    const rows = [...html.matchAll(/class="hm-attn-title">([^<]+)</g)].map((m) => m[1]);
    expect(rows[0]).toBe("Deploy of api in production failed");
    expect(rows[1]).toBe("3 waiting in Review");
  });

  it("counts Unplaced in Review's row", () => {
    const s = state({ badges: { proposals: 1, decisions: 0, unplaced: 4 } });
    s.home.attnOpen = true;
    const t = text(page(s));
    expect(t).toContain("5 waiting in Review");
    expect(t).toContain("1 to review · 4 unplaced");
  });

  it("a suspended GitHub App: an admin gets Fix first; a member a calm row with no action and no red", () => {
    const gh = { status: "ok" as const, data: { configured: true, installation: { suspended_at: new Date().toISOString() }, lost: null, mismatch: null } as never };
    const admin = state({}, "owner"); admin.home.github = gh; admin.home.attnOpen = true;
    const a = page(admin);
    expect(text(a)).toContain("GitHub is suspended");
    expect(a).toMatch(/data-act="orgGo" data-arg="integrations">Fix</);
    const member = state({}, "member"); member.home.github = gh; member.home.attnOpen = true;
    const m = page(member);
    expect(text(m)).toContain("Repo updates are paused");
    expect(text(m)).not.toContain("GitHub is suspended");
    expect(m).not.toMatch(/>Fix</);
  });

  it("an unknown figure is \"—\" (Docs promoted before promotions were timed), never 0", () => {
    const s = state();
    s.home.data = { status: "ok", data: home({ days: days((i) => ({ docs: i < HOME_DAYS - 3 ? null : 1, tickets: i >= HOME_DAYS - 7 ? 2 : 0 })) }) };
    const html = page(s);
    const cards = [...html.matchAll(/<span class="hm-card-l">([^<]+)<\/span>\s*<span class="hm-card-n"[^>]*>([^<]+)</g)].map((m) => [m[1], m[2]]);
    expect(cards).toContainEqual(["Docs promoted", "—"]);
    expect(cards).toContainEqual(["Tickets done", "14"]);
    expect(text(html)).toContain("+14 vs previous 7 days");
  });

  it("Activity's read still out draws four ghost cards; a failed one says so with Try again", () => {
    const s = state(); s.home.data = { status: "loading", data: null };
    expect((page(s).match(/class="hm-card is-ghost"/g) ?? []).length).toBe(4);
    s.home.data = { status: "error", data: null };
    expect(page(s)).toMatch(/Couldn't load activity\.[\s\S]*data-act="homeRetry"/);
  });

  it("no repository: the ghost offers Connect to an admin, and tells a member an admin connects one", () => {
    const orgMe = { status: "ok" as const, data: { repos: { primary: null, all: [] } } as never };
    expect(text(page(state({ orgMe }, "owner")))).toContain("Connect a repository");
    const m = text(page(state({ orgMe }, "member")));
    expect(m).toContain("An admin connects one");
    expect(m).not.toContain("Connect a repository");
  });

  it("a repository's last push, and \"No pushes yet\" only for the primary", () => {
    const s = state();
    s.home.data = { status: "ok", data: home({ repos: [{ repo: "acme/app", primary: true, lastPush: null, accessLost: false }, { repo: "acme/docs", primary: false, lastPush: null, accessLost: false }] }) };
    const html = page(s);
    expect(html.match(/No pushes yet/g)?.length).toBe(1);
  });

  it("the ⌘K hint stays while the bar is focused; a typed query takes its place", () => {
    const s = state(); s.home.focused = true;
    expect(page(s)).toContain('class="hm-kbd"');
    s.home.q = "class";
    expect(page(s)).not.toContain('class="hm-kbd"');
  });
});

describe("Home — the answer under the bar", () => {
  const base = { q: "What shipped?", phase: "done" as const, error: null, threadId: 7, wrong: "closed" as const };
  it("shows a cited ref as its title, Ask's byline, the sources and Wrong?, and Continue in Trov", () => {
    const html = homeAnswerView({ ...base, text: "We shipped [[ticket:12]].", cites: [{ ref: "ticket:12", type: "ticket", title: "SSO loop", status: null, href: "#tickets/12" } as never] });
    expect(html).toContain("We shipped SSO loop.");
    expect(html).toContain("Written by Trov just now");
    expect(html).toMatch(/data-act="homeAnsGo" data-arg="#tickets\/12">SSO loop</);
    expect(html).toContain('data-act="homeAnsWrongOpen"');
    expect(html).toContain('data-act="homeAnsContinue"');
  });
  it("Wrong? opens Ask's three reasons, then thanks", () => {
    const open = homeAnswerView({ ...base, text: "x", cites: [], wrong: "open" });
    expect(open.match(/data-act="homeAnsWrong"/g)?.length).toBe(3);
    expect(homeAnswerView({ ...base, text: "x", cites: [], wrong: "sent" })).toContain("Thanks. Trov was told.");
  });
  it("while it thinks there is no byline yet; an error says so", () => {
    expect(homeAnswerView({ ...base, text: "", cites: [], phase: "thinking" })).not.toContain("Written by Trov");
    expect(homeAnswerView({ ...base, text: "", cites: [], phase: "error", error: "Monthly AI allowance used." })).toContain("Monthly AI allowance used.");
  });
});

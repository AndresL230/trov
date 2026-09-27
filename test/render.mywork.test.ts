/**
 * My Work render tests — the Claude Design bento (web/src/mywork.ts) plus the
 * Roadmap narrative's two side boxes as a rail, composed by render.ts.
 *
 * Row renderers are tested directly; the full render() tree is driven with the
 * markdown module mocked (marked + DOMPurify cannot run in workerd — the same
 * escaping mock render.roadmap.test.ts uses).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../web/src/markdown", () => ({
  renderMarkdown: (s: string) => `<div class="mock-md">${s.replace(/</g, "&lt;")}</div>`,
  renderMarkdownInline: (s: string) => `<span class="mock-mdi">${s.replace(/</g, "&lt;")}</span>`,
  enhance: () => {},
  sanitizeSvg: (s: string) => s,
}));

import { render, initialState } from "../web/src/render";
import { mwTicketRow, reviewTile, repoTile, ticketsTile, mwSpans, libraryStrip } from "../web/src/mywork";
import type { MyWorkPr, MyWorkTodo, MyWorkTicket, DashboardData } from "@shared/dashboard";
import type { PersonSummary } from "../web/src/api";
import type { ReviewItem } from "../web/src/review";

function makePr(overrides: Partial<MyWorkPr> = {}): MyWorkPr {
  return {
    number: 42, title: "Fix the thing", displayTitle: null,
    url: "https://github.com/SaplingLearn/sapling/pull/42", merged: true,
    occurredAt: new Date().toISOString(), what: null, why: null, impact: null, baseRef: null,
    ...overrides,
  };
}
function makeTodo(overrides: Partial<MyWorkTodo> = {}): MyWorkTodo {
  return {
    number: 7, title: "Investigate flaky test", displayTitle: null, priority: "P1",
    labels: ["bug", "flaky", "ci", "extra"], url: "https://github.com/SaplingLearn/sapling/issues/7",
    updatedAt: new Date().toISOString(), summary: null, sprint: null, nextStep: null,
    ...overrides,
  };
}
const PERSONS: PersonSummary[] = [
  { handle: "meilin", name: "Meilin Zhao", color: "rose", avatar_url: null },
  { handle: "alice", name: "Alice Ng", color: "moss", avatar_url: null },
];
function makeTicket(overrides: Partial<MyWorkTicket> = {}): MyWorkTicket {
  return {
    id: 12, title: "SSO login loops on Safari", body: "It bounces me back to the sign-in page.",
    category: "bug", priority: "high", status: "submitted", source: "canopy", requester: "meilin",
    sprint: { id: 3, label: "Sprint 13 — Tickets" },
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 7200_000).toISOString(),
    ...overrides,
  };
}

// ── rows ─────────────────────────────────────────────────────────────────────

describe("mwTicketRow", () => {
  it("is an in-app open control with NO numeric id and no external link", () => {
    const html = mwTicketRow(makeTicket());
    expect(html).toMatch(/^<button data-act="openTicket" data-arg="12"/);
    expect(html).toContain("SSO login loops on Safari");
    expect(html).not.toContain("github.com");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toMatch(/>#\d/);
  });

  it("shows the sprint's due date, amber when it is this week", () => {
    expect(mwTicketRow(makeTicket(), { label: "Oct 2", soon: true })).toContain('color:var(--amber)">due Oct 2');
    expect(mwTicketRow(makeTicket(), { label: "Nov 9", soon: false })).toContain('color:var(--fg-40)">due Nov 9');
    expect(mwTicketRow(makeTicket(), { label: "Jun 10", soon: false, overdue: true })).toContain('color:var(--red)">overdue Jun 10');
    expect(mwTicketRow(makeTicket())).not.toContain("due ");
  });

  it("shows status, sprint (Backlog when none) and the monochrome priority", () => {
    const html = mwTicketRow(makeTicket({ status: "in_progress", priority: "low", sprint: null }));
    expect(html).toContain("In progress");
    expect(html).toContain("Backlog");
    expect(html).toContain(">Low<");
    const prio = html.slice(0, html.indexOf(">Low<"));
    expect(prio).not.toContain("var(--amber)");
    expect(prio).not.toContain("var(--red)");
  });

  it("escapes a hostile title and sprint label", () => {
    const html = mwTicketRow(makeTicket({ title: "<img src=x onerror=alert(1)>", sprint: { id: 1, label: "<b>boom</b>" } }));
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>boom</b>");
    expect(html).toContain("&lt;img");
  });
});

// ── tiles ────────────────────────────────────────────────────────────────────

describe("mwSpans — the design's grid rule", () => {
  it("leads 7/5, splits the rest evenly, and shares the strip row", () => {
    expect(mwSpans(["tickets", "review", "sessions", "repo"], ["library"])).toEqual({ tickets: 7, review: 5, sessions: 6, repo: 6, library: 12 });
    expect(mwSpans(["sessions", "repo"], ["review", "library"])).toEqual({ sessions: 7, repo: 5, review: 6, library: 6 });
    expect(mwSpans(["review", "sessions", "repo"], ["library"])).toEqual({ review: 7, sessions: 5, repo: 12, library: 12 });
  });
});

describe("libraryStrip", () => {
  const lib = (handoffs: Parameters<typeof libraryStrip>[0]["handoffs"]) => libraryStrip({
    docs: { load: "ok", total: 3, stale: ["Gate vocabulary"] },
    artifacts: { load: "ok", publishedThisWeek: 4, latest: { slug: "triage-map", title: "Triage map", at: new Date().toISOString() } },
    handoffs,
  }, 12);

  it("names the three cells; the third is the queued handoffs — the row opens it, the button copies it", () => {
    const html = lib({ load: "ok", count: 2, newest: { id: 9, title: "Finish the <b>gate</b> port", at: new Date().toISOString() } });
    expect(html).toContain("Docs you own");
    expect(html).toContain("1 not updated in 30 days");
    expect(html).toContain("4 published this week");
    expect(html).toContain("Queued handoffs");
    expect(html).toContain('data-act="goHandoffs"');
    expect(html).toContain("2 for you");
    expect(html).toContain("Finish the &lt;b&gt;gate&lt;/b&gt; port");
    expect(html).toContain('data-act="openHandoff" data-arg="9"');
    expect(html).toContain('data-act="mwHandoffCopy" data-arg="9"');
    expect(html).toContain("Copy</button>");
    expect(html).not.toContain(">Open<");
    // The prompt cell and its Copy path are gone.
    expect(html).not.toContain("Saved prompts");
    expect(html).not.toContain("mwCopyPrompt");
    expect(html).not.toContain("claimHandoff");
  });

  it("the handoffs cell: empty, loading and failed each say so", () => {
    expect(lib({ load: "ok", count: 0, newest: null })).toContain("No handoffs queued.");
    expect(lib({ load: "pending", count: 0, newest: null })).toContain("Loading");
    expect(lib({ load: "error", count: 0, newest: null })).toContain("Couldn't load.");
  });
});

describe("list tiles — the design's height", () => {
  it("show three rows, then an in-place 'Show N more' that expands", () => {
    const rows = [1, 2, 3, 4, 5].map((id) => makeTicket({ id, title: `T${id}` }));
    const html = ticketsTile({ load: "ok", rows }, false, 7);
    expect(html).toContain("T3");
    expect(html).not.toContain("T4");
    expect(html).toContain('data-act="mwMore" data-arg="tickets"');
    expect(html).toContain("Show 2 more");
    const open = ticketsTile({ load: "ok", rows, expanded: true }, false, 7);
    expect(open).toContain("T5");
    expect(open).toContain("Show less");
    expect(ticketsTile({ load: "ok", rows: rows.slice(0, 3) }, false, 7)).not.toContain("mwMore");
  });
});

describe("reviewTile", () => {
  const item = (id: string, kind: "proposal" | "decision"): ReviewItem => ({
    id, kind, eyebrow: "", badge: "Staged", badgeColor: "var(--amber)", title: `Item ${id}`, summary: "",
    agent: "kai", agentInitials: "KA", time: "1h ago",
  });

  it("carries the Review screen's own verdict acts, Promote vs Ratify by kind", () => {
    const html = reviewTile([item("d:a:2", "proposal"), item("a:5", "decision")], "ok", 5);
    expect(html).toContain('data-act="reviewAccept" data-arg="d:a:2"');
    expect(html).toContain('data-act="reviewReject" data-arg="a:5"');
    expect(html).toContain("Needs your review");
    expect(html).toContain(">Promote<");
    expect(html).toContain(">Ratify<");
    expect(html).toContain("1 to promote, 1 to ratify");
  });

  it("shows three and points to the rest", () => {
    const html = reviewTile(["1", "2", "3", "4", "5"].map((i) => item(i, "proposal")), "ok", 5);
    expect(html).toContain("Item 3");
    expect(html).not.toContain("Item 4");
    expect(html).toContain("2 more in Review");
  });

  it("an empty, loaded queue reads clear — a loading one never does", () => {
    expect(reviewTile([], "ok", 5)).toContain("Nothing waiting on your review");
    expect(reviewTile([], "pending", 5)).not.toContain("Nothing waiting on your review");
    expect(reviewTile([], "pending", 5)).toContain("Loading");
  });
});

describe("repoTile", () => {
  it("says not connected rather than showing a zero", () => {
    const repo = { repo: "SaplingLearn/sapling", environments: { status: "not_connected" }, prs: { status: "not_connected" } } as unknown as Parameters<typeof repoTile>[0];
    const html = repoTile(repo, "ok", "prs", 6);
    expect(html).toContain("Not connected yet");
    expect(html).not.toMatch(/>0</);
  });

  type Repo = NonNullable<Parameters<typeof repoTile>[0]>;
  const dash = (over: Record<string, unknown>): Repo => ({ repo: "SaplingLearn/sapling", environments: { status: "not_connected" }, drift: { status: "not_connected" }, ...over }) as unknown as Repo;
  const pr = (number: number, state: string) => ({ number, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`, author: { login: "x", handle: null, name: null, color: null }, branch: "feat/x", state, checks: null, at: new Date().toISOString() });

  it("PRs: shows the projection's real open count, not a count of the capped list", () => {
    const rows = [pr(1, "review"), pr(2, "merged")];
    const html = repoTile(dash({ prs: { status: "ok", data: { openCount: 14, rows } } }), "ok", "prs", 6);
    expect(html).toContain(">14<");
    expect(html).toContain("open pull requests");
    expect(html).not.toContain("not captured");
  });

  it("PRs: an unknown open count says so — never '0 open pull requests'", () => {
    const html = repoTile(dash({ prs: { status: "ok", data: { openCount: null, rows: [pr(3, "merged")] } } }), "ok", "prs", 6);
    expect(html).toContain("Open PRs not captured yet — showing recent merged/closed");
    expect(html).not.toMatch(/>0</);
    expect(html).not.toContain("open pull requests");
    expect(html).toContain("PR 3");
  });

  it("CI: counts from `total`, not the capped rows, and prints the rate as the percentage it already is", () => {
    const row = { workflow: "e2e", branch: "main", job: "suite", at: new Date().toISOString(), url: "https://github.com/o/r/actions/runs/1" };
    const html = repoTile(dash({ ciFailures: { status: "ok", data: { rate: 6.7, trend: [], rows: Array(5).fill(row), total: 12 } } }), "ok", "ci", 6);
    expect(html).toContain(">12<");
    expect(html).toContain("CI failures this week · 6.7% of runs");
    expect(html).not.toContain("670");
  });

  it("Deploys: a DOWN environment reads 'down', a FAILING one 'failing'", () => {
    const env = (name: string, pill: string, tone: string) => ({ key: name, name, note: null, tone, pill, parts: [], ci: "", ciTone: "neutral", url: "" });
    const html = repoTile(dash({ environments: { status: "ok", data: [env("staging", "DOWN", "bad"), env("production", "FAILING", "bad"), env("preview", "HEALTHY", "good")] } }), "ok", "deploys", 6);
    expect(html).toContain("environments · 1 down · 1 failing");
    const quiet = repoTile(dash({ environments: { status: "ok", data: [env("staging", "DOWN", "bad")] } }), "ok", "deploys", 6);
    expect(quiet).toContain("environment · 1 down");
    expect(quiet).not.toContain("failing");
  });

  it("labels the sample set as sample data; live data carries no tag", () => {
    const prs = { status: "ok", data: { openCount: 1, rows: [pr(1, "review")] } };
    expect(repoTile(dash({ sample: true, prs }), "ok", "prs", 6)).toContain("Sample data");
    expect(repoTile(dash({ prs }), "ok", "prs", 6)).not.toContain("Sample data");
  });

  it("switches views through the segmented control", () => {
    const html = repoTile(null, "pending", "ci", 6);
    expect(html).toContain('data-seg="mw-repo"');
    // PRs first, then CI and Deploys — no drift (environment-named) option.
    const labels = [...html.matchAll(/class="cnpy-seg-btn[^"]*"[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    expect(labels).toEqual(["PRs", "CI", "Deploys"]);
    expect(html).toContain('data-act="mwRepoTab" data-arg="prs"');
    expect(html).not.toContain('data-arg="drift"');
    expect(html).toContain("Loading");
  });
});

// ── full render() — My Work screen composition ──────────────────────────────

describe("render() — My Work screen", () => {
  function stateWithDashboard(data: DashboardData, admin = false): ReturnType<typeof initialState> {
    const s = initialState();
    return {
      ...s,
      view: "app",
      screen: "mywork",
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss", identities: [], org: "SaplingLearn", admin },
      persons: { status: "ok", data: PERSONS },
      mywork: { status: "ok", data },
    };
  }
  const dash = (o: Partial<DashboardData> = {}): DashboardData =>
    ({ person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false, ...o });

  it("holds exactly the design's five tiles, in its order — nothing else", () => {
    const html = render(stateWithDashboard(dash({ previousActivity: [makePr()], todo: [makeTodo()], tickets: [makeTicket()] })));
    const labels = [...html.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
    // The review queue has not loaded in this state, so its tile holds its place (loading).
    expect(labels).toEqual(["Tickets for you", "Needs your review", "Your sessions", "Repo monitor", "Your library"]);
    // The GitHub issue / PR lists stay off this screen (My Work's DTO still carries them for MCP).
    expect(html).not.toContain("Issues assigned to you");
    expect(html).not.toContain("Your recent PRs");
    expect(html).not.toContain("https://github.com/SaplingLearn/sapling/issues/7");
    expect(html).not.toContain("Recent happenings");
  });

  it("drops Tickets when there are none; a clear review queue reads clear beside Repo", () => {
    const s = stateWithDashboard(dash());
    const html = render({ ...s, proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } });
    const labels = [...html.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
    // Clear: Sessions alone, then Repo 7 | Needs your review 5 — the clear tile beside Repo.
    expect(labels).toEqual(["Your sessions", "Repo monitor", "Needs your review", "Your library"]);
    expect(html).toContain("Nothing waiting on your review");
    const spanOf = (k: string) => html.match(new RegExp(`--span:(\\d+)[^"]*"[^>]*data-mw="${k}"`))?.[1];
    expect([spanOf("sessions"), spanOf("repo"), spanOf("review"), spanOf("library")]).toEqual(["12", "7", "5", "12"]);
    // …and with tickets: Tickets 7 | Sessions 5, then Repo 7 | review 5.
    const withT = render({ ...stateWithDashboard(dash({ tickets: [makeTicket()] })), proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] } });
    const lbl = [...withT.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
    expect(lbl).toEqual(["Tickets for you", "Your sessions", "Repo monitor", "Needs your review", "Your library"]);
  });

  it("degraded:true keeps the tickets tile, with a hint instead of empty copy", () => {
    const html = render(stateWithDashboard(dash({ person: null, degraded: true })));
    expect(html).toContain("Couldn't load your assigned tickets right now.");
    expect(html).not.toContain("The queue has what's waiting.");
  });

  it("greets the person and summarises what is waiting", () => {
    const html = render(stateWithDashboard(dash({ tickets: [makeTicket()] })));
    expect(html).toMatch(/Good (morning|afternoon|evening), /);
    expect(html).toContain("1 ticket open");
  });

  // ── admin-only Sync GitHub button (server-side backfill trigger) ────────────
  it("renders the Sync GitHub backfill button for an admin me", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const html = render(stateWithDashboard(data, true));
    expect(html).toContain('data-act="adminBackfill"');
    expect(html).toContain("Sync GitHub");
  });

  it("does NOT render the Sync GitHub button for a non-admin me", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const html = render(stateWithDashboard(data, false));
    expect(html).not.toContain('data-act="adminBackfill"');
  });

  it("shows a disabled Sync button while backfillSync is set", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "progress", prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } as const };
    const html = render(s);
    expect(html).toContain("disabled");
    expect(html).toContain("Syncing");
    expect(html).not.toContain("Sync GitHub");
  });

  it("renders two progress bars — PRs and issues — while backfillSync is in progress", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "progress", prSummarizedCount: 66, prsTotal: 146, issueSummarizedCount: 3, issuesTotal: 10 } as const };
    const html = render(s);
    expect(html).toContain("66 of 146 PRs summarized");
    expect(html).toContain("width:45%"); // Math.round(66/146*100)
    expect(html).toContain("3 of 10 issues summarized");
    expect(html).toContain("width:30%"); // Math.round(3/10*100)
  });

  it("renders an inventory-taking line — never '0 of 0' bars — while the first batch is in flight", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const s = { ...stateWithDashboard(data, true), backfillSync: { phase: "starting" } as const };
    const html = render(s);
    expect(html).toContain("Syncing GitHub");
    expect(html).toContain("Contacting GitHub");
    expect(html).not.toContain("0 of 0");
  });

  // A ticket's due date is its sprint's, read through the ONE due-date rule
  // (shared/sprints-core sprintDueState) — due all of that day, overdue from the next.
  it("dueOf: a sprint due today is due (amber, this week); one due yesterday is overdue", () => {
    const iso = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    const withDue = (due: string) => {
      const s = stateWithDashboard(dash({ tickets: [makeTicket({ sprint: { id: 3, label: "Sprint 13" } })] }));
      return render({ ...s, sprints: { status: "ok", data: [{ id: 3, due } as never] } });
    };
    const today = withDue(iso(0));
    expect(today).toMatch(/color:var\(--amber\)">due /);
    expect(today).not.toContain(">overdue ");
    expect(today).toContain("1 due this week");
    const late = withDue(iso(-1));
    expect(late).toMatch(/color:var\(--red\)">overdue /);
    expect(late).toContain("1 overdue");
    const far = withDue(iso(8));
    expect(far).toMatch(/color:var\(--fg-40\)">due /);
    expect(far).not.toContain("due this week");
  });

  it("renders no progress modal when backfillSync is null", () => {
    const data: DashboardData = { person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false };
    const html = render(stateWithDashboard(data, true));
    expect(html).not.toContain("Syncing GitHub");
  });

});

// ── Get Started guide copy ───────────────────────────────────────────────────
// The guide is the one prose surface that describes My Work and the Roadmap, so
// it drifts silently. These pin the corrected spec's wording.

describe("render() — the Get Started guide", () => {
  const guideState = () => {
    const s = initialState();
    return {
      ...s,
      view: "app" as const,
      screen: "guide" as const,
      me: { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin: false },
    };
  };

  it("describes My Work's tiles by the names on screen", () => {
    const html = render(guideState());
    for (const t of ["Tickets for you", "Needs your review", "Your sessions", "Repo"]) expect(html).toContain(t);
    expect(html).not.toContain("three lists");
    expect(html).not.toContain("Previous activity");
  });

  it("says sprint progress counts its TICKETS closed (done or declined), plus the GitHub issues it tracks", () => {
    const html = render(guideState());
    expect(html).toMatch(/progress bar that counts that sprint's tickets closed \(done or declined\) out of its total, plus any GitHub issues it tracks/);
    // The old cache-only wording is gone.
    expect(html).not.toContain("closed/total issue counts recomputed from GitHub events");
  });

  it("shows a figure for every screen in the sidebar, the ticket, sprint and artifact pages, and the connect modal", () => {
    const html = render(guideState());
    for (const name of ["mywork", "tickets", "board", "ticket", "roadmap", "sprint", "repo", "repo-usage", "feed", "docs", "search", "review", "maintenance", "settings", "connect", "handoffs", "artifacts", "artifact", "prompts", "timeline", "quicksearch", "releases"]) {
      expect(html).toContain(`/guide/${name}-`);
    }
  });

  it("has a table of contents whose every entry jumps to a heading on the page, in page order", () => {
    const html = render(guideState());
    const targets = [...html.matchAll(/data-act="guideJump" data-arg="([^"]+)"/g)].map((m) => m[1]);
    const ids = [...html.matchAll(/id="(guide-[^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThan(15);
    expect(targets).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    // Buttons, never #anchors: the hash is the route.
    expect(html).not.toMatch(/href="#guide-/);
  });

  it("carries no user-facing 'milestone' string anywhere in the guide", () => {
    expect(render(guideState())).not.toMatch(/milestone/i);
  });
});

// ── audit fixes: counts, own reads, honest greeting, stable review tile ──────

import { handoffBadge } from "../web/src/render";
import { handoffsForMe } from "../web/src/mywork";
import { reviewHeadsFromReads, reviewItemsFromReads } from "../web/src/triage-map";
import type { StagedProposal } from "../web/src/api";
import type { FeedRow, AdrRow, DocMetaRow } from "@shared/rows";
import type { HandoffView } from "@shared/handoffs";
// main.ts boots the whole app on import, so its loaders are pinned at the source.
const mainSrc = Object.values(import.meta.glob("../web/src/main.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>)[0];

describe("My Work — audit fixes", () => {
  const ME = { handle: "alice", name: "Alice", avatar_url: null, color: "moss" as const, identities: [], org: "SaplingLearn", admin: false };
  const dash = (o: Partial<DashboardData> = {}): DashboardData =>
    ({ person: "alice", previousActivity: [], todo: [], tickets: [], ticketsTotal: 0, degraded: false, ...o });
  /** Every slice My Work reads, loaded ok and empty — override what a test is about. */
  function loaded(o: Partial<ReturnType<typeof initialState>> = {}): ReturnType<typeof initialState> {
    return {
      ...initialState(), view: "app", screen: "mywork", me: ME, persons: { status: "ok", data: PERSONS },
      mywork: { status: "ok", data: dash() },
      proposals: { status: "ok", data: [] }, draftAdrs: { status: "ok", data: [] },
      handoffs: { status: "ok", data: [] }, mwSessions: { status: "ok", data: [] },
      ...o,
    };
  }
  const feedRow = (id: number, author: string, summary: string): FeedRow =>
    ({ id, author, summary, brief: null, body: null, artifacts: null, created_at: new Date().toISOString() });
  const handoff = (id: number, sender: string, recipient: string, status: HandoffView["status"] = "pending"): HandoffView => ({
    id, sender, recipient, status, created_at: new Date().toISOString(), claimed_at: null, claimed_by: null, claimed_by_session: null,
    prompt: null, body: `Handoff ${id} title\nmore`, context: { repo: "", branch: "", task: "", done: [], next: [], files: [] },
  });
  const proposal = (slug: string, created_at: string): StagedProposal => ({
    slug, version: 2, title: `Doc ${slug}`, section: "architecture", space: "technical", summary: null, author: "kai",
    confidence: "high", status: "staged", change_kind: "edit", low_confidence: 0, base_version: 1, current_version: 1,
    created_at, stagedBody: "a\nb\nc", promotedBody: "a\nc",
  });
  const adr = (id: number, created_at: string): AdrRow => ({
    id, title: `ADR ${id}`, context: null, decision: "We do it.", rationale: null, status: "draft", confidence: null,
    created_at, created_by: "kai", content_hash: null,
  });
  const labels = (html: string) => [...html.matchAll(/data-screen-label="My Work · ([^"]+)"/g)].map((m) => m[1]);
  const dateLine = (html: string) => html.match(/margin-top:6px;text-wrap:balance">([^<]*)</)![1];

  // 1. ticketsTotal
  it("'N open' is the uncapped total; 'Show N more' only offers the loaded rows, then links to the queue", () => {
    const rows = [1, 2, 3, 4, 5, 6].map((id) => makeTicket({ id, title: `T${id}` }));
    const html = ticketsTile({ load: "ok", rows, total: 12 }, false, 7);
    expect(html).toContain("12 open");
    expect(html).toContain("Show 3 more");
    expect(html).not.toContain("more in the queue");
    const open = ticketsTile({ load: "ok", rows, total: 12, expanded: true }, false, 7);
    expect(open).toContain("Show less");
    expect(open).toContain('data-act="mwAllTickets"');
    expect(open).toContain("6 more in the queue");
    // Everything loaded: no queue link.
    expect(ticketsTile({ load: "ok", rows, total: 6, expanded: true }, false, 7)).not.toContain("mwAllTickets");
  });

  it("the greeting counts the uncapped total, not the capped list", () => {
    const html = render(loaded({ mywork: { status: "ok", data: dash({ tickets: [makeTicket()], ticketsTotal: 12 }) } }));
    expect(dateLine(html)).toContain("12 tickets open");
  });

  // 2. Your sessions reads its own slice
  it("Your sessions shows My Work's own read, never the Feed screen's (filtered) list", () => {
    const html = render(loaded({
      feed: { status: "ok", data: [feedRow(1, "alice", "From the FEED screen")] },
      feedAuthor: "bob",
      mwSessions: { status: "ok", data: [feedRow(2, "alice", "My own session")] },
    }));
    expect(html).toContain("My own session");
    expect(html).not.toContain("From the FEED screen");
  });

  it("Your sessions shows two sessions and one handoff, however many wait", () => {
    const html = render(loaded({
      mwSessions: { status: "ok", data: [1, 2, 3].map((id) => feedRow(id, "alice", `Session ${id}`)) },
      handoffs: { status: "ok", data: [1, 2, 3].map((id) => handoff(id, "bob", "alice")) },
    }));
    const tile = html.slice(html.indexOf('data-mw="sessions"'), html.indexOf('data-mw="repo"'));
    expect((tile.match(/data-act="goFeed" class="mw-row"/g) ?? []).length).toBe(2);
    expect(tile).not.toContain("Session 3");
    expect((tile.match(/data-act="openHandoff"/g) ?? []).length).toBe(1);
    expect(tile).toContain("3 handoffs waiting for a fresh session");
  });

  it("Your sessions: loading, error and empty each say so honestly", () => {
    const tileOf = (html: string) => html.slice(html.indexOf('data-mw="sessions"'), html.indexOf('data-mw="repo"'));
    expect(tileOf(render(loaded({ mwSessions: { status: "loading", data: [] } })))).toContain("Loading");
    expect(tileOf(render(loaded({ mwSessions: { status: "error", data: [], error: "x" } })))).toContain("Couldn't load your recent sessions.");
    expect(tileOf(render(loaded()))).toContain("Nothing recorded yet.");
  });

  // 3. the greeting's claim
  it("says 'nothing is waiting on you' only when every contributing slice loaded ok", () => {
    expect(dateLine(render(loaded()))).toContain("nothing is waiting on you");
    // Still loading: just the date.
    const loading = render(loaded({ proposals: { status: "loading", data: [] } }));
    expect(loading).not.toContain("nothing is waiting on you");
    expect(dateLine(loading)).not.toContain("·");
    expect(render(loaded({ mywork: { status: "loading", data: null } }))).not.toContain("nothing is waiting on you");
    expect(render(loaded({ handoffs: { status: "idle", data: [] } }))).not.toContain("nothing is waiting on you");
    // Failed: no claim either way.
    expect(render(loaded({ draftAdrs: { status: "error", data: [], error: "x" } }))).not.toContain("nothing is waiting on you");
    expect(render(loaded({ mywork: { status: "ok", data: dash({ degraded: true }) } }))).not.toContain("nothing is waiting on you");
  });

  // 4. review tile: data on hand = ok
  it("a refetch in flight after a verdict keeps the review tile's items and its place", () => {
    const now = new Date().toISOString();
    const settled = render(loaded({ proposals: { status: "ok", data: [proposal("a", now), proposal("b", now)] } }));
    const refreshing = render(loaded({ proposals: { status: "loading", data: [proposal("a", now), proposal("b", now)] } }));
    const tileOf = (html: string) => html.slice(html.indexOf('data-mw="review"'), html.indexOf('data-mw="sessions"'));
    expect(tileOf(refreshing)).not.toContain("Loading");
    expect(tileOf(refreshing)).toContain("Doc a");
    expect(labels(refreshing)).toEqual(labels(settled));
  });

  it("the tile's review heads carry no diff, in the Review screen's own order and ids", () => {
    const ps = [proposal("a", "2026-09-01T00:00:00Z"), proposal("b", "2026-09-03T00:00:00Z")];
    const as = [adr(5, "2026-09-02T00:00:00Z")];
    const heads = reviewHeadsFromReads(ps, as);
    expect(heads.map((h) => h.id)).toEqual(reviewItemsFromReads(ps, as).map((i) => i.id));
    expect(heads.map((h) => h.id)).toEqual(["doc:b@2", "adr:5", "doc:a@2"]);
    for (const h of heads) expect(h).not.toHaveProperty("diff");
  });

  // 5. one handoff-count definition
  it("the sidebar badge and the tile count the SAME handoffs — self-sent included, anyone and claimed excluded", () => {
    const hs = [
      handoff(1, "bob", "alice"),              // for me
      handoff(2, "alice", "alice"),            // I handed off to my own next session
      handoff(3, "bob", "anyone"),             // anyone's — not waiting on me in particular
      handoff(4, "bob", "alice", "claimed"),   // already picked up
      handoff(5, "alice", "bob"),              // I sent it to someone else
    ];
    expect(handoffsForMe(hs, "Alice").map((h) => h.id)).toEqual([1, 2]);
    const s = loaded({ handoffs: { status: "ok", data: hs } });
    expect(handoffBadge(s)).toBe(2);
    const html = render(s);
    expect(html).toContain("2 handoffs waiting for a fresh session");
    expect(dateLine(html)).toContain("2 handoffs waiting");
    expect(html).not.toContain(">Waiting<");
    // None waiting: the tile says nothing about handoffs (the library strip's cell does).
    const none = render(loaded({ handoffs: { status: "ok", data: [handoff(3, "bob", "anyone")] } }));
    const tile = none.slice(none.indexOf('data-mw="sessions"'), none.indexOf('data-mw="sessions"') + 2000);
    expect(tile).not.toMatch(/handoffs? waiting/i);
    expect(none).toContain("No handoffs queued.");
  });

  // Docs you own: meta read, stubs excluded
  it("Docs you own counts docs.owner (not the last promoter), skipping never-promoted stubs", () => {
    const doc = (slug: string, v: number, owner: string | null, updatedBy = "alice"): DocMetaRow =>
      ({ slug, section: "reference", title: `Doc ${slug}`, current_version: v, updated_at: new Date().toISOString(), updated_by: updatedBy, space: "technical", owner });
    const html = render(loaded({ mwDocs: { status: "ok", data: [
      doc("live", 2, "alice"),                 // mine
      doc("stub", 0, "alice"),                 // mine, but never promoted
      doc("promoted-by-me", 3, "bob"),         // I promoted it last, bob owns it
      doc("mine-promoted-by-bob", 1, "Alice", "bob"), // mine (handles compare case-insensitively)
    ] } }));
    expect(html).toContain("2 docs");
    expect(html).not.toContain("3 docs");
  });

  // Load cost: pinned at the source — main.ts boots the whole app, so it cannot be imported here.
  it("My Work's loader never pulls the doc bodies or the Feed screen's list, and the boot never re-fetches the review queue", () => {
    const body = (name: string) => {
      const at = mainSrc.indexOf(`function ${name}(`);
      return mainSrc.slice(at, mainSrc.indexOf("\n}\n", at));
    };
    const mw = body("loadMyWorkIfNeeded");
    expect(mw).not.toMatch(/\bloadDocs\(/);
    expect(mw).not.toMatch(/\bloadFeed\(/);
    expect(mw).toContain("loadMwDocs()");
    expect(mw).toContain("loadMwSessions()");
    expect(body("loadMwDocs")).toContain("listDocMeta()");
    expect(body("loadMwSessions")).toContain("limit: 2");
    // The boot's badge loads are guarded, so a screen loader that already started them (My Work, Review) is not doubled.
    expect(mainSrc).toContain('if (state.proposals.status === "idle") loadProposals();');
    expect(mainSrc).toContain('if (state.draftAdrs.status === "idle") loadDraftAdrs();');
    expect(mainSrc).not.toMatch(/^\s*loadProposals\(\);\s*\n\s*loadDraftAdrs\(\);/m);
  });

  it("Your sessions links to the Feed (the tile lists feed entries)", () => {
    const html = render(loaded());
    const tile = html.slice(html.indexOf('data-mw="sessions"'), html.indexOf('data-mw="repo"'));
    expect(tile).toContain('data-act="goFeed"');
    expect(tile).toContain("Feed");
    expect(tile).not.toContain('data-act="goHandoffs"');
  });

  it("the library's queued-handoffs cell counts the same set as the badge, newest first", () => {
    const hs = [handoff(1, "bob", "alice"), handoff(3, "bob", "anyone"), handoff(2, "alice", "alice")];
    hs[0].created_at = "2026-09-01T00:00:00Z"; hs[2].created_at = "2026-09-20T00:00:00Z";
    const s = loaded({ handoffs: { status: "ok", data: hs } });
    const html = render(s);
    const cell = html.slice(html.indexOf("Queued handoffs"));
    expect(cell).toContain(`${handoffBadge(s)} for you`);
    expect(cell).toContain('data-act="openHandoff" data-arg="2"');
    expect(render(loaded())).toContain("No handoffs queued.");
    expect(render(loaded({ handoffs: { status: "loading", data: [] } }))).not.toContain("No handoffs queued.");
  });
});

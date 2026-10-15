/**
 * Ask Trov's inspector (web/src/ask-inspector.ts; inventory §6, #12 §3): every `insp:<type>` scenario, `answer-pr`,
 * `phone-insp`, an upload and a chart, rendered from the fixtures (shared/ai-fixtures.ts `askRefFixtures` + the
 * inspector's detail fixtures, as `GET /ask/item/:ref` answers them); the reads it makes and when; the acts; the
 * guards (a hidden item shows nothing of itself, the replay never writes, Publish is the author's); the motion.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => `<md>${b}</md>`, renderMarkdownInline: (t: string) => t, sanitizeSvg: (s: string) => s }));
import { render, initialState, type AppState } from "../web/src/render";
import { askView, type AskCtx } from "../web/src/ask-state";
import { inspectorFrame } from "../web/src/ask-screen";
import {
  animateNav, chartLine, chartRef, clipMarkdown, fmtSize, inspectorBody, inspectorIo, inspectorPart, sprintForecast, uploadRef,
} from "../web/src/ask-inspector";
import { CHART_FIXTURE, INSPECTOR_LOCAL_FIXTURES, UPLOAD_FIXTURE, inspectorDetailFixture, repoStateFixture } from "../web/src/ask-inspector-fixtures";
import { INSP_FIXTURE, replayPlan } from "../web/src/ask-replay";
import { emptyConvo, newTurn } from "../web/src/ask-stream";
import { repoScenario, SCENARIO_KEYS, SCENARIO_VARIANTS } from "../web/src/repo-sample";
import { repoVerdicts, verdictMark } from "../web/src/ask-refs";
import { AskApiError } from "../web/src/ask-api";
import { askRefFixtures, askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import { askRepoFacts, type AskItem, type RefView } from "@shared/ai-ask-core";
import css from "../web/src/trov.css?raw";

const NOW = new Date("2026-10-15T12:00:00Z");
const ME = { handle: "andres", name: "Andres Lopez", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "acme", name: "Acme", role: "owner" as const }], superadmin: false, pending_invites: 0 };
const PEOPLE = [
  { handle: "andres", name: "Andres Lopez", color: "moss" as const, avatar_url: null, role: null },
  { handle: "maya", name: "Maya Chen", color: "sky" as const, avatar_url: null, role: null },
  { handle: "priya", name: "Priya Natarajan", color: "plum" as const, avatar_url: null, role: null },
  { handle: "jon", name: "Jon Park", color: "ochre" as const, avatar_url: null, role: null },
];
const REPO = "repo:AndresL230/trov";

function views(): Record<string, RefView> {
  const v = askRefFixtures(NOW);
  v[REPO] = { ...v[REPO], extra: { facts: askRepoFacts(repoScenario("N", "trov", { now: NOW.getTime() })) } };
  return v;
}
/** The Ask screen with `stack` open in the inspector, and every item's read in. */
function state(stack: string[], over: (s: AppState) => void = () => undefined): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "acme";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PEOPLE } as AppState["persons"];
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  s.ask.threads = { status: "ok", data: askThreadsFixture(NOW) };
  s.ask.refViews = views();
  s.ask.inspector = { ...s.ask.inspector, stack, idx: stack.length - 1 };
  for (const ref of stack) {
    const detail = inspectorDetailFixture(ref, NOW.getTime(), s.ask.refViews as Record<string, RefView>);
    const view = s.ask.refViews[ref] as RefView | undefined;
    if (detail && view) s.ask.inspectorUi.items[ref] = { status: "ok", data: { view, detail } };
  }
  over(s);
  return s;
}
const body = (s: AppState, ref = s.ask.inspector.stack[s.ask.inspector.idx]) => inspectorBody(askView(s, "page"), ref);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ");

describe("every insp:<type> scenario renders its view from the fixtures (#12 §3)", () => {
  it("covers each type the replay opens", () => {
    expect(Object.keys(INSP_FIXTURE).sort()).toEqual(["artifact", "doc", "feed", "handoff", "person", "pr", "repo", "sprint", "ticket"]);
    for (const [type, ref] of Object.entries(INSP_FIXTURE)) expect(body(state([ref]))).toContain(`data-ask-iv="${type}"`);
  });

  it("ticket: number and title, status, priority, category, body, requester and opened date, assignees, its sprint with the due date, sub-tickets, linked PRs, latest comments", () => {
    const t = text(body(state(["ticket:14"])));
    for (const s of ["#14", "Guided repository setup", "In progress", "High", "Request", "Take a new org from", "Jon Park", "opened Sep 28",
      "Maya Chen", "Andres Lopez", "Hosting", "Due Fri, Oct 30", "Sub-tickets", "1 of 3 done", "#21", "Linked pull requests",
      "Netlify connect step for guided setup", "#176 · In review", "Checks failing", "Checks passing", "Latest comments",
      "The test still asserts on the old pill markup"]) expect(t).toContain(s);
    const html = body(state(["ticket:14"]));
    // The sprint opens beside the thread; people open here too (their picture through people.ts).
    expect(html).toContain(`data-act="askShOpen" data-arg="sprint:7"`);
    expect(html).toContain(`data-act="askShOpen" data-arg="person:maya"`);
    expect(html).toContain(`class="cnpy-av"`);
    expect(html).toContain(`data-act="askShOpen" data-arg="ticket:22"`);
  });

  it("a ticket with no one on it reads Unassigned, and no sprint reads Backlog", () => {
    const s = state(["ticket:14"], (st) => {
      const it = st.ask.inspectorUi.items["ticket:14"].data as AskItem;
      it.detail = { ...it.detail, ticket: { ...(it.detail.ticket as object), assignees: [], sprint: null } };
      st.ask.refViews["ticket:14"] = { ...(st.ask.refViews["ticket:14"] as RefView), extra: { priority: "high", assignees: [], sprint: null } };
    });
    const t = text(body(s));
    expect(t).toContain("Unassigned");
    expect(t).toContain("Backlog");
  });

  it("pr: repository, author, head → base, updated, checks with marks and 'N of M checks pass', What / Why / Impact, Linked to", () => {
    const html = body(state(["pr:176"]));
    const t = text(html);
    for (const s of ["#176 · AndresL230/trov", "Netlify connect step for guided setup", "In review", "Maya Chen", "Updated", "maya/netlify-connect", "main",
      "Checks", "3 of 4 checks pass", "netlify-connect.test", "What", "Adds the Netlify step", "Why", "Impact", "Linked to"]) expect(t).toContain(s);
    expect(html).toContain(`data-mtip="netlify-connect.test failed"`);
    expect(html).toContain(`data-ask-ref="ticket:14"`);
    // files / +/− lines are not captured (null on the route): never a guessed 0.
    expect(t).not.toMatch(/\b0 files\b|\+0\b/);
  });

  it("doc: space and version, owner, updated, a rendered (sanitized) excerpt, the Staged mark and its note, Open doc", () => {
    const html = body(state(["doc:release-0-30-notes"]));
    const t = text(html);
    for (const s of ["Release 0.30 notes", "Staged, not approved", "Product · v2", "Priya Natarajan", "Updated", "What is new in 0.30",
      "This version waits in Review. Agents still read v1 until someone approves it.", "Open doc"]) expect(t).toContain(s);
    expect(html).toContain("<md>");                                   // through the app's renderMarkdown (DOMPurify)
    expect(html).toContain(`data-act="openDocFrom" data-arg="release-0-30-notes"`);
    const live = text(body(state(["doc:hosting-connections"])));
    expect(live).toContain("Live");
    expect(live).not.toContain("waits in Review");
  });

  it("sprint: dates, due, lead, goal, the progress bar with 'N of M tickets done', the forecast, tickets by status with 'and N more'", () => {
    const html = body(state(["sprint:7"]));
    const t = text(html);
    for (const s of ["Hosting", "Oct 5 – 30", "Due Fri, Oct 30", "Andres Lopez", "Any org can connect Netlify or Vercel", "58%", "7 of 12 tickets done",
      "At this pace, done", "In progress", "Testing", "Triage", "Done", "and 3 more"]) expect(t).toContain(s);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="58"/);
    expect(html).toContain(`class="ask-iv-fill" style="width:58%"`);
  });

  it("handoff: from, to, created, task, Done, Next (display only), files", () => {
    const html = body(state(["handoff:11"]));
    const t = text(html);
    for (const s of ["Handoff #11", "Carry the performance plan forward", "Pending", "From", "Andres Lopez", "To", "Anyone", "Task",
      "batch the D1 reads", "Done", "Profiled the Repo dashboard read", "Next", "Re-measure the dashboard", "Files", "src/tools/repo.ts"]) expect(t).toContain(s);
    expect(html).not.toContain(`role="checkbox"`);                    // the design's local ticks are prototype-only
  });

  it("feed: author with the agent mark, time, title, brief, body, sources", () => {
    const html = body(state(["feed:41"]));
    const t = text(html);
    for (const s of ["Priya Natarajan", "agent", "Status marks replace pills", "Every board, table and rail now shows state", "Tickets show a ring",
      "Sources", "#173", "a1c9e2f", "Commit"]) expect(t).toContain(s);
    expect(html).toContain(`data-act="askShOpen" data-arg="pr:173"`);
  });

  it("person: avatar through people.ts, @handle, role, Working on now, recent pull requests", () => {
    const html = body(state(["person:maya"]));
    const t = text(html);
    for (const s of ["Maya Chen", "@maya", "Engineer. Guided setup.", "Working on now", "Guided repository setup", "Recent pull requests", "#171"]) expect(t).toContain(s);
    expect(html).toMatch(/class="cnpy-av"[^>]*width:52px/);
  });

  it("artifact: kind and version, Private, a frame for the live preview, and Publish to org for its author", () => {
    const html = body(state(["artifact:hosting-status-oct-15"]));
    const t = text(html);
    for (const s of ["Hosting status, Oct 15", "Private", "HTML page · v1", "acme/a/hosting-status-oct-15",
      "Only you can see it. Publishing puts it in Artifacts for everyone in Acme.", "Publish to org"]) expect(t).toContain(s);
    expect(html).toContain(`data-act="askInPublish" data-arg="artifact:hosting-status-oct-15"`);
  });

  it("artifact: with a raw page, the preview IS the viewer's sandboxed frame (allow-scripts, never same-origin)", () => {
    const s = state(["artifact:hosting-status-oct-15"], (st) => {
      const it = st.ask.inspectorUi.items["artifact:hosting-status-oct-15"].data as AskItem;
      it.detail = { ...it.detail, raw_url: "/api/o/acme/raw/a/hosting-status-oct-15@v1" };
    });
    const html = body(s);
    expect(html).toContain(`class="art-frame" data-art-key="hosting-status-oct-15@1"`);
    expect(html).toMatch(/<iframe title="Hosting status, Oct 15" src="[^"]*" sandbox="allow-scripts"/);
    expect(html).not.toContain("allow-same-origin");
  });
});

describe("repo: the Overview's facts (#186) — RepoFacts, its verdicts, stateMark", () => {
  it.each(SCENARIO_KEYS.flatMap((k) => SCENARIO_VARIANTS[k].map((v) => [k, v] as const)))("scenario %s/%s: environments by name with the Overview's marks; hosts by the part's label", (k, variant) => {
    const facts = askRepoFacts(repoScenario(k, variant, { now: NOW.getTime() }));
    const s = state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts } }; });
    const html = body(s);
    for (const { env, verdict } of repoVerdicts(facts)) {
      expect(html).toContain(esc(env.name));
      expect(html).toContain(verdictMark(verdict, 12.5));
      // Healthy only when the branch head's checks PASS.
      if (verdict.key === "healthy") expect(facts.ci.find((c) => c.env === env.key)?.state).toBe("pass");
    }
    for (const p of facts.parts) {
      expect(html).toContain(esc(p.host));
      expect(text(html)).not.toMatch(new RegExp(`on ${p.provider}\\b`));   // never a provider id for a host
    }
  });

  it("scenario N: the State headline and its Shipped / In flight / At risk lists, last deploy, CI on the branch", () => {
    const s = state([REPO], (st) => { st.ask.inspectorUi.repoState[REPO] = { status: "ok", data: repoStateFixture(NOW.getTime()) }; });
    const t = text(body(s));
    for (const x of ["AndresL230/trov", "Environments", "Last deploy", "CI on", "State", "Hosting is close. One test is red on main",
      "Shipped", "Status marks replace pills", "In flight", "At risk", "netlify-connect.test.ts fails on main"]) expect(t).toContain(x);
  });

  it("no facts read: Unknown, never Healthy, never zero — and where it is connected", () => {
    const s = state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts: null } }; });
    const html = body(s);
    expect(text(html)).toContain("Unknown");
    expect(text(html)).not.toContain("Healthy");
    expect(html).toContain(`href="#org"`);
    expect(text(html)).toContain("Org settings › Integrations");
  });

  it("no checks captured on the head reads Live, never Healthy", () => {
    const base = askRepoFacts(repoScenario("N", "trov", { now: NOW.getTime() }));
    const facts = { ...base, ci: [], outOfStep: [], parts: base.parts.map((p) => ({ ...p, latest: null, health: null })) };
    const s = state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts } }; });
    const t = text(body(s));
    expect(t).toContain("Live");
    expect(t).not.toContain("Healthy");
    expect(t).toContain("No checks captured on the branch head.");
  });

  it("a host that is not connected points to Org settings › Hosting; no environments to Environments and the repo's Apps", () => {
    const base = askRepoFacts(repoScenario("N", "trov", { now: NOW.getTime() }));
    const off = { ...base, parts: base.parts.map((p, i) => (i === 0 ? { ...p, connection: "not_connected" as const } : p)) };
    let html = body(state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts: off } }; }));
    expect(html).toContain(`href="#org/hosting"`);
    const none = { ...base, envs: [], parts: [] };
    html = body(state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts: none } }; }));
    expect(html).toContain(`href="#org/environments"`);
    expect(html).toContain(`href="#org/repos/AndresL230/trov"`);
  });

  it("a monorepo names its apps; a narrowed read names the one app", () => {
    const many = SCENARIO_KEYS.map((k) => askRepoFacts(repoScenario(k, SCENARIO_VARIANTS[k][0], { now: NOW.getTime() }))).find((f) => f.apps.filter((a) => a.kind !== "Package").length > 1);
    expect(many).toBeDefined();
    const html = body(state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts: many } }; }));
    for (const a of many!.apps.filter((x) => x.kind !== "Package")) expect(html).toContain(esc(a.label));
    const one = { ...many!, app: many!.apps[0].key };
    const narrowed = text(body(state([REPO], (st) => { st.ask.refViews[REPO] = { ...(st.ask.refViews[REPO] as RefView), extra: { facts: one } }; })));
    expect(narrowed).toContain(`App: ${many!.apps[0].label}`);
  });
});

describe("upload and chart (no RefView: web-side fixtures — the contract gap)", () => {
  it("upload: a preview (or the striped placeholder), the size, the promise", () => {
    const f = INSPECTOR_LOCAL_FIXTURES.upload;
    const s = state([f.ref], (st) => { st.ask.inspectorUi.local = { [f.ref]: f.item }; });
    const t = text(body(s));
    expect(t).toContain("ci-failure.png");
    expect(t).toContain("Image · 412 KB");
    expect(t).toContain("Attached to this thread. Trov reads it only when you ask about it.");
    expect(body(s)).toContain("ask-iv-ph--stripe");
    const withThumb = state([f.ref], (st) => { st.ask.inspectorUi.local = { [f.ref]: { kind: "upload", att: { ...UPLOAD_FIXTURE, thumbUrl: "/api/o/acme/raw/a/ci-failure-png@v1" } } }; });
    expect(body(withThumb)).toMatch(/<img class="ask-iv-img" src="\/api\/o\/acme\/raw\/a\/ci-failure-png@v1" alt="ci-failure.png">/);
  });

  it("upload: found in the conversation's question by its id; the frame names it Upload", () => {
    const ref = uploadRef(UPLOAD_FIXTURE.id);
    const s = state([ref], (st) => {
      st.ask.page = { ...emptyConvo(), messages: [{ role: "user", key: "q1", text: "Why is this failing?", context: [], attachments: [UPLOAD_FIXTURE], command: null } as never] };
    });
    expect(text(body(s))).toContain("412 KB");
    const frame = inspectorFrame(askView(s, "page"));
    expect(frame).toContain(`<span class="ask-insp-type">Upload</span>`);
  });

  it("chart: larger, the line under its title, a Chart / Table segmented switch; the table has Week of / value / Total", () => {
    const f = INSPECTOR_LOCAL_FIXTURES.chart;
    const s = state([f.ref], (st) => { st.ask.inspectorUi.local = { [f.ref]: f.item }; });
    let html = body(s);
    expect(text(html)).toContain("48 merged pull requests on AndresL230/trov, Aug 24 – Oct 18");
    expect(html).toContain(`class="cnpy-seg cnpy-seg--sm"`);
    expect(html).toContain(`data-act="askInChartView" data-arg="${f.ref}|table"`);
    expect(html.match(/class="ask-iv-barfill"/g)).toHaveLength(8);
    expect(text(html)).toContain("Data from Trov · merged pull requests, by the week they merged");
    s.ask.inspectorUi.chartView[f.ref] = "table";
    html = body(s);
    const t = text(html);
    expect(t).toMatch(/Week of\s+Merged pull requests/);
    expect(t).toMatch(/Oct 12\s+6/);
    expect(t).toMatch(/Total\s+48/);
    expect(html).not.toContain("ask-iv-barfill");
  });

  it("chart: found in the answer that holds it (chartRef), and the frame names it Chart", () => {
    const turn = { ...newTurn("smart"), parts: [{ kind: "text" as const, md: "Pace" }, { kind: "block" as const, block: { kind: "chart" as const, chart: CHART_FIXTURE } }] };
    const ref = chartRef("a1", 1);
    const s = state([ref], (st) => { st.ask.page = { ...emptyConvo(), messages: [{ role: "assistant", key: "a1", turn }] }; });
    expect(text(body(s))).toContain("Merged PRs by week");
    expect(inspectorFrame(askView(s, "page"))).toContain(`<span class="ask-insp-type">Chart</span>`);
  });

  it("an upload or chart no longer in the thread says so", () => {
    expect(text(body(state([uploadRef(5)])))).toContain("This is no longer in this thread.");
  });
});

describe("the frame: answer-pr and phone-insp", () => {
  it("answer-pr: stack #14 → #176 → #173, the trail 'from #14 › #176', Back enabled, the type word", () => {
    const s = state(["ticket:14", "pr:176", "pr:173"], (st) => { st.ask.threadsForced = false; });
    const frame = inspectorFrame(askView(s, "page"));
    expect(frame).toContain(`<span class="ask-insp-from">from #14 › #176</span>`);
    expect(frame).toContain(`<span class="ask-insp-type">Pull request</span>`);
    expect(frame).toMatch(/data-act="askShBack" aria-label="Back">/);
    expect(frame).toContain(`data-morph-key="insp:pr:173"`);
    expect(text(frame)).toContain("Status marks replace pills");
    expect(replayPlan("answer-pr").play).toEqual(["answer"]);
  });

  it("phone-insp: the body inside the full-height sheet, no resize edge", () => {
    const s = state(["ticket:14"], (st) => { st.phone = true; });
    const html = render(s);
    expect(html).toMatch(/<aside class="ask-insp-frame"[^>]*data-sheet="1"/);
    expect(html).not.toContain("ask-insp-resize");
    expect(html).toContain(`data-ask-iv="ticket"`);
  });

  it("the whole screen renders with the item open (render.ts end to end)", () => {
    const html = render(state(["sprint:7"]));
    expect(html).toContain(`data-ask-iv="sprint"`);
    expect(html).toContain("7 of 12 tickets done");
  });
});

describe("loading, failing, hidden", () => {
  it("while the read is out: the header from the RefView, a skeleton for the rest (aria-busy)", () => {
    const s = state(["ticket:14"], (st) => { st.ask.inspectorUi.items = { "ticket:14": { status: "loading", data: null } }; });
    const html = body(s);
    expect(html).toContain("Guided repository setup");
    expect(html).toMatch(/class="cnpy-skel" data-skel="ask-insp-ticket-14" aria-busy="true"/);
    expect(html).not.toContain("Sub-tickets");
  });
  it("no RefView yet: a whole-body skeleton", () => {
    const s = state(["ticket:99"]);
    expect(body(s)).toContain(`aria-busy="true"`);
  });
  it("a failed read: one line and Try again", () => {
    const s = state(["ticket:14"], (st) => { st.ask.inspectorUi.items = { "ticket:14": { status: "error", data: null } }; });
    const html = body(s);
    expect(html).toContain(`data-act="askInRetry" data-arg="ticket:14"`);
    expect(text(html)).toContain("Couldn't read the rest of this item.");
  });

  // GUARD (#12 §4 "peek hides items the person can't see", the inspector's half): a ref peek answered `hidden` — or a
  // read that 404s — shows one sentence and NOTHING of the item, even what an earlier read left in the store.
  it("GUARD: a hidden item shows nothing of itself, even with a stale read in the store", () => {
    const s = state(["ticket:14"], (st) => { st.ask.refViews["ticket:14"] = { ref: "ticket:14", hidden: true }; });
    const html = body(s);
    expect(text(html)).toContain("This item is not there, or it is not yours to see.");
    expect(html).not.toContain("Guided repository setup");
    expect(html).not.toContain("Netlify");
    const gone = state(["ticket:14"], (st) => { st.ask.inspectorUi.items["ticket:14"] = { status: "ok", data: null }; });
    expect(body(gone)).not.toContain("Guided repository setup");
  });
});

// ── the part ─────────────────────────────────────────────────────────────────

function ctxFor(s: AppState, o: { replay?: boolean; getItem?: (ref: string) => Promise<AskItem> } = {}): AskCtx & { flashes: string[]; wanted: string[][] } {
  const flashes: string[] = [];
  const wanted: string[][] = [];
  return {
    app: s, ui: s.ask, replay: o.replay ?? false, flashes, wanted,
    api: { getItem: o.getItem ?? (async (ref: string) => ({ view: s.ask.refViews[ref] as RefView, detail: inspectorDetailFixture(ref, NOW.getTime()) ?? {} })) } as never,
    look: () => ({ views: s.ask.refViews, persons: s.persons.data }),
    paint: () => undefined, flash: (m: string) => { flashes.push(m); }, fail: () => undefined, want: (r: readonly string[]) => { wanted.push([...r]); },
    send: () => undefined, stop: () => undefined, openRef: () => undefined, closeInspector: () => undefined, newThread: () => undefined,
    openThread: () => undefined, reloadThreads: () => undefined, exit: (_k: string, apply: () => void) => apply(), cancelExit: () => undefined,
  };
}
const mount = { querySelector: () => null } as unknown as HTMLElement;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the part's reads and acts", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("reads the open item ONCE, after paint (never on the render path), and warms the refs it names", async () => {
    const s = state(["person:maya"], (st) => { st.ask.inspectorUi.items = {}; });
    const getItem = vi.fn(async (ref: string) => ({ view: s.ask.refViews[ref] as RefView, detail: inspectorDetailFixture(ref, NOW.getTime()) ?? {} }));
    const ctx = ctxFor(s, { getItem });
    body(s);                                   // rendering reads nothing
    expect(getItem).not.toHaveBeenCalled();
    inspectorPart.afterPaint!(ctx, mount);
    inspectorPart.afterPaint!(ctx, mount);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(s.ask.inspectorUi.items["person:maya"].status).toBe("loading");
    await flush();
    expect(s.ask.inspectorUi.items["person:maya"].status).toBe("ok");
    expect(ctx.wanted.flat()).toEqual(expect.arrayContaining(["pr:176", "pr:171", "ticket:14"]));
  });

  it("a 404 is 'not there' (hidden), any other failure an error with Try again; Try again reads again", async () => {
    const s = state(["ticket:14"], (st) => { st.ask.inspectorUi.items = {}; });
    const ctx = ctxFor(s, { getItem: async () => { throw new AskApiError(404, "not_found", "not_found"); } });
    inspectorPart.afterPaint!(ctx, mount);
    await flush();
    expect(s.ask.inspectorUi.items["ticket:14"]).toEqual({ status: "ok", data: null });
    const s2 = state(["ticket:14"], (st) => { st.ask.inspectorUi.items = {}; });
    const ctx2 = ctxFor(s2, { getItem: async () => { throw new AskApiError(500, "failed", "failed"); } });
    inspectorPart.afterPaint!(ctx2, mount);
    await flush();
    expect(s2.ask.inspectorUi.items["ticket:14"].status).toBe("error");
    inspectorPart.act!(ctx2, "askInRetry", "ticket:14", null);
    expect(s2.ask.inspectorUi.items["ticket:14"]).toBeUndefined();
  });

  it("never reads an item peek hid", () => {
    const s = state(["ticket:14"], (st) => { st.ask.inspectorUi.items = {}; st.ask.refViews["ticket:14"] = { ref: "ticket:14", hidden: true }; });
    const getItem = vi.fn();
    inspectorPart.afterPaint!(ctxFor(s, { getItem }), mount);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("an upload / chart is never read from the server", () => {
    const f = INSPECTOR_LOCAL_FIXTURES.chart;
    const s = state([f.ref], (st) => { st.ask.inspectorUi.local = { [f.ref]: f.item }; });
    const getItem = vi.fn();
    inspectorPart.afterPaint!(ctxFor(s, { getItem }), mount);
    expect(getItem).not.toHaveBeenCalled();
  });

  it("a repository's State is the Repo dashboard's own read, once", async () => {
    const s = state([REPO]);
    const spy = vi.spyOn(inspectorIo, "repoState").mockResolvedValue(repoStateFixture(NOW.getTime()));
    const ctx = ctxFor(s);
    inspectorPart.afterPaint!(ctx, mount);
    inspectorPart.afterPaint!(ctx, mount);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("AndresL230/trov");
    await flush();
    expect(text(body(s))).toContain("Hosting is close.");
  });

  it("no State written is no State box (never an error over the facts)", async () => {
    const s = state([REPO]);
    vi.spyOn(inspectorIo, "repoState").mockRejectedValue(new Error("down"));
    inspectorPart.afterPaint!(ctxFor(s), mount);
    await flush();
    expect(s.ask.inspectorUi.repoState[REPO]).toEqual({ status: "ok", data: null });
    expect(text(body(s))).not.toContain("State ");
  });

  it("the Chart / Table switch", () => {
    const f = INSPECTOR_LOCAL_FIXTURES.chart;
    const s = state([f.ref]);
    const ctx = ctxFor(s);
    inspectorPart.act!(ctx, "askInChartView", `${f.ref}|table`, null);
    expect(s.ask.inspectorUi.chartView[f.ref]).toBe("table");
    inspectorPart.act!(ctx, "askInChartView", `${f.ref}|pie`, null);
    expect(s.ask.inspectorUi.chartView[f.ref]).toBe("table");
  });

  // GUARD: under the dev replay nothing is written — Publish shows what would be, and calls no write.
  it("GUARD: Publish to org under the replay writes nothing", () => {
    const ref = "artifact:hosting-status-oct-15";
    const s = state([ref]);
    const spy = vi.spyOn(inspectorIo, "publishArtifact").mockResolvedValue(undefined);
    const ctx = ctxFor(s, { replay: true });
    inspectorPart.act!(ctx, "askInPublish", ref, null);
    expect(spy).not.toHaveBeenCalled();
    expect(ctx.flashes).toEqual(["Published to Acme"]);
    expect((s.ask.refViews[ref] as RefView).status?.word).toBe("Org");
    expect(text(body(s))).not.toContain("Publish to org");
  });

  it("Publish to org writes once, as the person, then the item reads Org", async () => {
    const ref = "artifact:hosting-status-oct-15";
    const s = state([ref]);
    const spy = vi.spyOn(inspectorIo, "publishArtifact").mockResolvedValue(undefined);
    const ctx = ctxFor(s);
    inspectorPart.act!(ctx, "askInPublish", ref, null);
    inspectorPart.act!(ctx, "askInPublish", ref, null);       // a second click while it runs is ignored
    expect(text(body(s))).toContain("Publishing…");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("hosting-status-oct-15");
    await flush();
    expect((s.ask.refViews[ref] as RefView).status?.word).toBe("Org");
    expect(s.ask.inspectorUi.publishing[ref]).toBeUndefined();
    expect(ctx.flashes).toEqual(["Published to Acme"]);
  });

  // GUARD: Publish is the author's step — anyone else never sees the button (only the author sees a private page).
  it("GUARD: Publish to org is offered only to the artifact's author, and only while it is private", () => {
    const ref = "artifact:hosting-status-oct-15";
    const other = state([ref], (st) => { (st as { me: unknown }).me = { ...ME, handle: "maya" }; });
    expect(body(other)).not.toContain("askInPublish");
    const org = state([ref], (st) => {
      const it = st.ask.inspectorUi.items[ref].data as AskItem;
      it.detail = { ...it.detail, visibility: "org" };
    });
    expect(body(org)).not.toContain("askInPublish");
  });
});

describe("helpers", () => {
  it("the sprint forecast is said only when it can be: pace since the start, carried forward", () => {
    const s = { start: "2026-10-05", due: "2026-10-30", status: "in_progress" as const, progress: { closed: 7, total: 12, pct: 58 } };
    expect(sprintForecast(s, NOW.getTime())).toEqual({ late: -7, text: "At this pace, done Oct 23, 7 days early" });
    expect(sprintForecast({ ...s, progress: { closed: 2, total: 12, pct: 17 } }, NOW.getTime())?.text).toBe("At this pace, done Dec 4, 35 days late");
    expect(sprintForecast({ ...s, progress: { closed: 0, total: 12, pct: 0 } }, NOW.getTime())).toBeNull();
    expect(sprintForecast({ ...s, start: null }, NOW.getTime())).toBeNull();
    expect(sprintForecast({ ...s, status: "done" }, NOW.getTime())).toBeNull();
  });
  it("chart lines, sizes, excerpts", () => {
    expect(chartLine(CHART_FIXTURE, 2026)).toBe("48 merged pull requests on AndresL230/trov, Aug 24 – Oct 18");
    expect(chartLine({ ...CHART_FIXTURE, params: {} }, 2026)).toBe("48 merged pull requests, Aug 24 – Oct 18");
    expect(fmtSize(421_888)).toBe("412 KB");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3 MB");
    expect(clipMarkdown("a\n\nb\n\nc", 2)).toBe("a\n\nb");
  });
});

describe("motion", () => {
  class El {
    animations: Keyframe[][] = [];
    constructor(public cls: string, public textContent = "", public kids: El[] = []) {}
    animate(frames: Keyframe[]) { this.animations.push(frames); return {}; }
    querySelector(sel: string): El | null {
      const want = sel === ".ask-iv" ? "ask-iv" : sel === ".ask-insp-from" ? "ask-insp-from" : sel.startsWith("[data-act=\"askShBack\"]") ? "back" : "";
      for (const k of this.kids) { if (k.cls === want) return k; const r = k.querySelector(sel); if (r) return r; }
      return null;
    }
  }
  const frame = (trail: string) => { const view = new El("ask-iv"), from = new El("ask-insp-from", trail), back = new El("back"); return { root: new El("frame", "", [view, from, back]), view, from, back }; };

  it("the first paint of a frame animates nothing (the frame slides in on its own); a repaint of the same item nothing", () => {
    const f = frame("");
    expect(animateNav(f.root as unknown as Element, "ticket:14", 0, false)).toBe(0);
    expect(animateNav(f.root as unknown as Element, "ticket:14", 0, false)).toBe(0);
  });
  it("forward slides the view in from the right with its trail; Back from the left, nudging the arrow", () => {
    const f = frame("");
    animateNav(f.root as unknown as Element, "ticket:14", 0, false);
    f.from.textContent = "from #14";
    expect(animateNav(f.root as unknown as Element, "pr:176", 1, false)).toBe(2);
    expect(f.view.animations[0][0]).toMatchObject({ transform: "translateX(14px)" });
    f.from.textContent = "";
    expect(animateNav(f.root as unknown as Element, "ticket:14", 0, false)).toBe(3);
    expect(f.view.animations[1][0]).toMatchObject({ transform: "translateX(-14px)" });
    expect(f.back.animations).toHaveLength(1);
  });
  it("nothing moves under reduced motion", () => {
    const f = frame("");
    animateNav(f.root as unknown as Element, "ticket:14", 0, true);
    expect(animateNav(f.root as unknown as Element, "pr:176", 1, true)).toBe(0);
    expect(f.view.animations).toHaveLength(0);
  });
  it("every inspector animation is switched off in the one reduced-motion block", () => {
    const reduce = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .ask-threads"));
    const block = reduce.slice(0, reduce.indexOf("\n}\n"));
    for (const cls of [".ask-iv-fill", ".ask-iv-barfill", ".ask-iv-table"]) expect(block).toContain(cls);
  });
});

function esc(s: string): string { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

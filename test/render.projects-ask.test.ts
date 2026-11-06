/**
 * Projects — a chat in a project is the Ask screen (docs/superpowers/specs/2026-11-05-projects.md › The screen):
 *   • the crumb reads "Projects › <project> › <thread>", the first two links back;
 *   • the thread list's first group is "In <project>" (the person's own threads in it, then others' shared with them),
 *     the usual groups after without those; a thread in a project carries the project's small tile;
 *   • the composer shows the project chip and "Uses <project>'s instructions and N pinned items";
 *   • the thread ⋯ menu gains "Move to project" (the person's live projects) and "Remove from project", which
 *     `PATCH /ask/threads/:id { project }`;
 *   • the project page's composer sends `POST /ask` with `projectId` and opens the thread on the Ask screen;
 *   • the sidebar has ONE new row, Projects, after Trov.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
type Handler = (path: string, init: RequestInit) => Response | Promise<Response>;
const transport: { handler: Handler; calls: { method: string; path: string; body: unknown }[] } = { handler: () => Response.json({}), calls: [] };
vi.mock("../web/src/api", async (orig) => {
  const real = await orig<typeof import("../web/src/api")>();
  return {
    ...real,
    apiFetch: async (path: string, init: RequestInit = {}) => {
      transport.calls.push({ method: init.method ?? "GET", path, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
      return transport.handler(path, init);
    },
  };
});

import { initialState, type AppState } from "../web/src/render";
import { createAskController } from "../web/src/ask-controller";
import { askView } from "../web/src/ask-state";
import { askHeader } from "../web/src/ask-screen";
import { composerView, projectFoot } from "../web/src/ask-composer";
import { threadsView, threadsPart, projectMark } from "../web/src/ask-threads";
import { emptyConvo } from "../web/src/ask-stream";
import { conversationView, turnErrorWords } from "../web/src/ask-conversation";
import { sidebarView, NAV_CLOSED } from "../web/src/sidebar";
import { askStateFixture, askThreadsFixture } from "@shared/ai-fixtures";
import { ASK_CHANGES_KEPT } from "@shared/ai-ask-core";
import { HOSTING_CHATS, HOSTING_DETAIL, PROJECT_LIST, PROJECT_FIXTURE_PEOPLE } from "@shared/projects-fixtures";
import type { PersonSummary } from "@shared/people";
import type { AskCtx } from "../web/src/ask-state";

const NOW = new Date("2026-11-05T22:30:00Z");
const ME = { handle: "AndresL230", name: "Andres", avatar_url: null, color: "moss" as const, identities: [], orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner" as const }], superadmin: false, pending_invites: 0 };
const HOSTING = { slug: "hosting-providers", name: "Hosting providers", icon: "server", color: "#525cc3" };

/** Ask, a thread in Hosting providers open: the person's own threads (three in the project), the project's page read. */
function app(): AppState {
  const s = initialState();
  s.view = "app"; s.screen = "ask"; s.orgSlug = "saplinglearn";
  (s as { me: unknown }).me = ME;
  s.persons = { status: "ok", data: PROJECT_FIXTURE_PEOPLE as unknown as PersonSummary[] } as AppState["persons"];
  s.ask.vw = 1440;
  s.ask.state = { status: "ok", data: askStateFixture("pro", NOW) };
  const own = HOSTING_CHATS.filter((t) => !t.viewer);
  s.ask.threads = { status: "ok", data: [...own, ...askThreadsFixture(NOW).map((t) => ({ ...t, id: t.id + 1000 }))] };
  s.ask.page = { ...emptyConvo(), threadId: 303, thread: own[2], title: own[2].title, status: "ok" };
  s.projects = { ...s.projects, list: { status: "ok", data: PROJECT_LIST }, detail: { status: "ok", data: HOSTING_DETAIL } };
  return s;
}

beforeEach(() => { transport.calls = []; transport.handler = () => Response.json({}); });

describe("Ask in a project — the crumb", () => {
  it("reads Projects › <project> › <thread>, the first two linking back", () => {
    const h = askHeader(app());
    expect(h.title).toContain('data-act="goProjects"');
    expect(h.title).toContain(">Projects<");
    expect(h.crumb).toContain('data-act="projOpen" data-arg="hosting-providers"');
    expect(h.crumb).toContain(">Hosting providers<");
    expect(h.crumb).toContain(">Why the Production backend deploy failed<");
  });
  it("a thread in no project keeps Ask's own crumb", () => {
    const s = app();
    s.ask.page = { ...s.ask.page, thread: { ...s.ask.page.thread!, project: null } };
    expect(askHeader(s).title).toContain("Ask Trov");
    expect(askHeader(s).crumb).not.toContain("projOpen");
  });
});

describe("Ask in a project — the thread list", () => {
  it("opens on “In <project>”: its threads (one shared with the person too), the usual groups after without them", () => {
    const html = threadsView(askView(app(), "page"));
    const head = html.indexOf("In Hosting providers");
    expect(head).toBeGreaterThan(-1);
    expect(head).toBeLessThan(html.indexOf(">Today<") < 0 ? Infinity : html.indexOf(">Today<"));
    // Each project thread once.
    expect(html.split('data-morph-key="th:302"').length - 1).toBe(1);
    // The one Jose shared with the org is in the group too, as a shared row.
    expect(html).toContain('data-morph-key="sh:290"');
    // A thread in a project carries the project's tile.
    expect(html).toContain('class="ask-th-proj" role="img" aria-label="In Hosting providers"');
    expect(projectMark({ project: null })).toBe("");
  });

  it("the ⋯ menu gains Move to project (the person's live projects but this one) and Remove from project", () => {
    const s = app();
    s.ask.threadMenu = 302;
    const html = threadsView(askView(s, "page"));
    expect(html).toContain(">Move to project<");
    expect(html).toContain('data-act="askThMove" data-arg="302|teacher-dashboard-pilot"');
    expect(html).toContain('data-act="askThMove" data-arg="302|exam-week-incident"');
    expect(html).not.toContain('data-act="askThMove" data-arg="302|hosting-providers"');
    expect(html).toContain('data-act="askThUnproject" data-arg="302"');
  });

  it("Move to project and Remove from project PATCH the thread's project", async () => {
    const s = app();
    const patched: unknown[] = [];
    const ctx = {
      app: s, ui: s.ask, replay: false, look: () => ({ views: {}, persons: [] }), paint: () => undefined, flash: () => undefined, fail: () => undefined,
      reloadThreads: () => undefined,
      api: { patchThread: async (id: number, patch: unknown) => { patched.push([id, patch]); return s.ask.threads.data[0]; } },
    } as unknown as AskCtx;
    threadsPart.act!(ctx, "askThMove", "302|teacher-dashboard-pilot", null);
    expect(s.ask.threads.data.find((t) => t.id === 302)?.project?.slug).toBe("teacher-dashboard-pilot");
    threadsPart.act!(ctx, "askThUnproject", "303", null);
    expect(s.ask.page.thread?.project).toBeNull();
    await Promise.resolve();
    expect(patched).toEqual([[302, { project: "teacher-dashboard-pilot" }], [303, { project: null }]]);
  });
});

describe("Ask in a project — the composer", () => {
  it("shows the project chip and the line saying what every turn reads", () => {
    const html = composerView(askView(app(), "page"));
    expect(html).toContain("ask-co-chip--proj");
    expect(html).toContain(">Hosting providers<");
    // Only what is there, and no possessive on the name.
    expect(html).toContain("Answers here read Hosting providers: its instructions and 9 pinned items");
    expect(projectFoot("X", null)).toBe("Answers here read X: its instructions and pinned items");
    expect(projectFoot("X", 1, null)).toBe("Answers here read X: its instructions and pinned items");
    expect(projectFoot("X", 1, true)).toBe("Answers here read X: its instructions and 1 pinned item");
    expect(projectFoot("X", 0, true)).toBe("Answers here read X: its instructions");
    expect(projectFoot("X", 3, false)).toBe("Answers here read X: its 3 pinned items");
    expect(projectFoot("X", 0, false)).toBe("X has no instructions or pinned items yet");
  });
});

describe("the project page's composer sends a new thread in the project", () => {
  it("prepares a new conversation in the project, sends POST /ask with projectId and moves to the Ask screen", async () => {
    const s = app();
    s.screen = "project";
    const ctl = createAskController({ state: s, mount: { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement, rerender: () => undefined, flash: () => undefined, unauth: () => undefined, search: () => "" });
    ctl.prepareProject(HOSTING);
    expect(s.ask.page).toMatchObject({ threadId: null, messages: [], project: HOSTING });
    const enc = new TextEncoder();
    transport.handler = (path) => path === "/ask"
      ? new Response(new ReadableStream({ start(c) { c.enqueue(enc.encode(`event: thread\ndata: ${JSON.stringify({ id: 77, title: "", mode: "smart", auto: false, origin: "page", contextRef: null })}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } })
      : Response.json({ threads: [] });
    ctl.ctx.send({ text: "What blocks the sprint?", where: "page" });
    expect(s.screen).toBe("ask");
    await vi.waitFor(() => expect(s.ask.page.threadId).toBe(77), { timeout: 3000 });
    const post = transport.calls.find((c) => c.path === "/ask")!;
    expect(post.body).toMatchObject({ threadId: null, text: "What blocks the sprint?", projectId: "hosting-providers" });
    // The new thread is the project's from its first event: the crumb names it.
    expect(s.ask.page.thread?.project).toEqual(HOSTING);
    // A conversation already in the project keeps its unsent words.
    s.ask.page = { ...emptyConvo(), project: HOSTING };
    s.ask.composer.page = { ...s.ask.composer.page, text: "half a question" };
    ctl.prepareProject(HOSTING);
    expect(s.ask.composer.page.text).toBe("half a question");
  });
});

describe("the project refuses a new thread (before anything streams)", () => {
  async function refusedWith(status: number, body: unknown) {
    const s = app();
    s.screen = "project";
    const ctl = createAskController({ state: s, mount: { querySelector: () => null, querySelectorAll: () => [] } as unknown as HTMLElement, rerender: () => undefined, flash: () => undefined, unauth: () => undefined, search: () => "" });
    ctl.prepareProject(HOSTING);
    transport.handler = (path) => (path === "/ask" ? Response.json(body, { status }) : Response.json({ threads: [] }));
    ctl.ctx.send({ text: "What blocks the sprint?", where: "page" });
    await vi.waitFor(() => expect(s.ask.page.busy).toBe(false), { timeout: 3000 });
    return conversationView(askView(s, "page"));
  }

  it("archived: the server's sentence, and no Try again", async () => {
    const html = await refusedWith(409, { error: "archived", message: "This project is archived. Restore it to change it." });
    expect(html).toContain("This project is archived. Restore it to change it.");
    expect(html).not.toContain("Something went wrong.");
    expect(html).not.toContain('data-act="askCvRetry"');
  });

  it("not_found: the project isn't there any more, and no Try again", async () => {
    const html = await refusedWith(404, { error: "not_found" });
    expect(html).toContain("This project isn&#39;t there any more.");
    expect(html).not.toContain('data-act="askCvRetry"');
  });

  it("any other failure, or a refusal outside a project, keeps the generic line with Try again", () => {
    expect(turnErrorWords({ threadId: null, project: HOSTING }, { code: "failed", message: "boom" })).toEqual({ title: "Something went wrong.", sub: "Nothing was changed.", retry: true });
    expect(turnErrorWords({ threadId: null, project: null }, { code: "not_found", message: "not_found" }).retry).toBe(true);
    // A stored thread's question never went with `projectId`: its not_found is the thread's, not the project's.
    expect(turnErrorWords({ threadId: 303, project: HOSTING }, { code: "not_found", message: "not_found" }).retry).toBe(true);
  });

  it("a busy conversation, Ask off, and a failure after Auto writes ran each say what is true", () => {
    expect(turnErrorWords({ threadId: 7, project: null }, { code: "busy", message: "x" })).toEqual({ title: "Trov is still answering in this conversation.", sub: "Wait for it to finish, then ask again.", retry: true });
    expect(turnErrorWords({ threadId: 7, project: null }, { code: "off", message: "Ask Trov is off for this org." })).toEqual({ title: "Ask Trov is off for this org.", sub: null, retry: false });
    expect(turnErrorWords({ threadId: 7, project: null }, { code: "failed", message: ASK_CHANGES_KEPT })).toEqual({ title: "Something went wrong.", sub: "The changes Trov already made are kept, each with its Undo.", retry: true });
  });
});

describe("the sidebar — one new row", () => {
  it("Projects sits after Trov in Workspace, lit on the list and on a project's home", () => {
    const base = { collapsed: false, navOpen: { ...NAV_CLOSED }, qView: "table" as const, roadmapTab: "timeline" as const, librarySpace: null, spaces: [], spacesLoaded: true, canAdmin: false, counts: { review: 0, tickets: 0, handoffs: 0, prompts: 0 }, me: null, displayName: "", logo: "" };
    const html = sidebarView({ ...base, screen: "project" });
    expect(html.indexOf('data-act="goProjects"')).toBeGreaterThan(html.indexOf('data-act="goAsk"'));
    expect(html.indexOf('data-act="goProjects"')).toBeLessThan(html.indexOf('data-act="goTickets"'));
    expect(html).toMatch(/class="cnpy-navrow n-projects is-active"/);
    expect(sidebarView({ ...base, screen: "projects" })).toMatch(/class="cnpy-navrow n-projects is-active"/);
    expect(sidebarView({ ...base, screen: "ask" })).toMatch(/class="cnpy-navrow n-projects"/);
  });
});

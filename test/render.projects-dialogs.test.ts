/**
 * Projects — the dialogs (web/src/projects.ts) and the controller's writes (web/src/projects-actions.ts):
 *   • New project / Edit details: the New space dialog's fields (name, icon, colour), who can see it as a
 *     `segmented()` named with the org, the short description, the plan line; Free at the cap cannot create; only the
 *     owner changes who can see it;
 *   • Add to <project>: the search, the type switch, the candidates grouped with their marks, already-pinned rows
 *     ticked and disabled, the private-artifact warning with Publish to org, the drop zone, "N selected", Add N;
 *   • Share: who can see it, add people (a `dropdown()`), each member's role, the note; a private project's members;
 *   • Delete: `confirmModal` with the spec's copy;
 *   • the writes go to PROJECT_ROUTES under the org, a 402 is the plan's one sentence, and Add to Knowledge and
 *     Archive put up a toast whose Undo takes it back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../web/src/markdown", () => ({ renderMarkdown: (b: string) => b, renderMarkdownInline: (t: string) => t }));
import { render, initialState, type AppState } from "../web/src/render";
import {
  projectDialog, pinDialog, shareDialog, deleteDialog, blankProjectDraft, draftFrom, blankPinPick, privatePicks, pinCandidates,
  pinRoomText, uploadRefusalText, deletedProjectText,
  type PinPick, type ShareDraft,
} from "../web/src/projects";
import { projectErrorText } from "../web/src/projects-api";
import { OrgApiError } from "../web/src/api";
import { createProjectsController } from "../web/src/projects-actions";
import { setApiOrg } from "../web/src/api";
import { initialDropdownUi } from "../web/src/dropdown";
import { esc } from "../web/src/ui";
import { HOSTING_DETAIL, PROJECT_LIST, PROJECT_LIST_FREE_CAP, PROJECT_PILOT, PROJECT_FIXTURE_PEOPLE, PROJECT_HOSTING } from "@shared/projects-fixtures";
import type { PersonSummary } from "@shared/people";
import css from "../web/src/trov.css?raw";
import mainSrc from "../web/src/main.ts?raw";

const PERSONS = PROJECT_FIXTURE_PEOPLE as unknown as PersonSummary[];
const opts = { org: "SaplingLearn", owner: true, limit: PROJECT_LIST.limit, plan: "Pro", role: "owner" as const };

describe("New project / Edit details", () => {
  it("has the New space dialog's fields, who can see it named with the org, the description and the plan line", () => {
    const html = projectDialog(blankProjectDraft(), opts);
    expect(html).toContain('data-confirm-dialog');
    expect(html).toContain(">New project<");
    expect(html).toContain('id="pj-name"');
    expect(html).toContain('class="cnpy-libm-icons"');
    expect(html).toContain('class="cnpy-libm-sws"');
    expect(html).toContain('data-seg="pj-vis"');
    for (const w of [">Private<", ">Members<", ">SaplingLearn<"]) expect(html).toContain(w);
    expect(html).toContain(esc("Only the people you add. The rest of SaplingLearn won’t see it."));
    expect(html).toContain('id="pj-desc"');
    expect(html).toContain("Pro · unlimited projects");
    // No name yet: Create is disabled.
    expect(html).toMatch(/data-act="projSave"[^>]*disabled/);
    expect(projectDialog({ ...blankProjectDraft(), name: "Spring rollout" }, opts)).not.toMatch(/data-act="projSave"[^>]*disabled/);
  });

  it("Free at the cap: says so (an owner is offered Upgrade to Pro) and cannot create", () => {
    const html = projectDialog({ ...blankProjectDraft(), name: "Third" }, { ...opts, limit: PROJECT_LIST_FREE_CAP.limit, plan: "Free" });
    expect(html).toContain("Free · 2 of 2 projects");
    expect(html).toContain(esc("You've used the 2 projects Free includes."));
    expect(html).toContain('data-act="projUpgrade"');
    expect(html).toMatch(/data-act="projSave"[^>]*disabled/);
  });

  it("Edit details: Save; an editor sees who can see it locked", () => {
    const html = projectDialog(draftFrom(PROJECT_PILOT), { ...opts, owner: false });
    expect(html).toContain(">Edit details<");
    // "color", as its field's label says.
    expect(html).toContain("Its name, icon and color show in Projects and on its chats.");
    expect(html).toContain(">Save<");
    expect(html).toContain("Only the owner can change who can see it.");
    expect(html).toMatch(/data-field="seg:pj-vis:private"[^>]*disabled/);
    expect(html).not.toContain("unlimited projects");
  });
});

describe("Add to <project>", () => {
  const pick = (over: Partial<PinPick> = {}): PinPick => ({
    ...blankPinPick(), q: "deploy", status: "ok",
    hits: [
      { ref: "ticket:87", type: "ticket", title: "Production backend deploy fails on Railway", status: "In progress" },
      { ref: "ticket:90", type: "ticket", title: "Docs: how to connect each hosting provider", status: "Triage" },
      { ref: "doc:hosting-connections", type: "doc", title: "Hosting connections", status: null },
      { ref: "artifact:railway-cold-start", type: "artifact", title: "Railway cold start notes", status: null },
      { ref: "person:jack-he", type: "person", title: "Jack", status: null },
    ],
    views: { "artifact:railway-cold-start": { ref: "artifact:railway-cold-start", type: "artifact", title: "Railway cold start notes", status: null, href: null, extra: { visibility: "private" } } },
    ...over,
  });

  it("groups the candidates a project may pin, ticks and disables what is already pinned, and counts what is picked", () => {
    const html = pinDialog(pick({ sel: ["ticket:90"] }), HOSTING_DETAIL);
    expect(html).toContain(">Add to Hosting providers<");
    expect(html).toContain("Pinned items stay live. Trov reads them first in every chat here.");
    expect(html).toContain('data-act="projPinQ"');
    expect(html).toContain('data-seg="pj-pin-type"');
    for (const w of [">Tickets<", ">Docs<", ">Artifacts<"]) expect(html).toContain(w);
    // A person is not something a project pins.
    expect(html).not.toContain("person:jack-he");
    expect(html).toMatch(/data-arg="ticket:87" checked disabled/);
    expect(html).toMatch(/data-arg="ticket:90" checked>/);
    expect(html).toContain("1 selected");
    expect(html).toContain(">Add 1<");
    expect(html).toContain('data-proj-drop');
    expect(html).toContain("Up to 10 MB each.");
  });

  it("with nothing picked: Add is disabled and the line asks what the project is about", () => {
    const html = pinDialog(pick(), HOSTING_DETAIL);
    expect(html).toContain("Pick what this project is about");
    expect(html).toMatch(/data-act="projPinGo"[^>]*disabled/);
  });

  it("a private artifact picked into a project others can open warns, with Publish to org", () => {
    const html = pinDialog(pick({ sel: ["artifact:railway-cold-start"] }), HOSTING_DETAIL);
    expect(html).toContain(esc("Railway cold start notes is private to you. People in this project won't see it until you publish it to the org."));
    expect(html).toContain('data-act="projPublish" data-arg="railway-cold-start"');
    // Not on a private project.
    expect(privatePicks(pick({ sel: ["artifact:railway-cold-start"] }), "private")).toEqual([]);
  });

  it("the type switch narrows the candidates", () => {
    expect(pinCandidates({ ...pick(), type: "doc" }).map((h) => h.ref)).toEqual(["doc:hosting-connections"]);
  });
});

describe("Share and Delete", () => {
  const share = (over: Partial<ShareDraft> = {}): ShareDraft => ({ visibility: "members", members: [{ handle: "Jose-Gael-Cruz-Lopez", role: "editor" }, { handle: "jack-he", role: "viewer" }], busy: false, error: null, ...over });

  it("Share: who can see it, add people, the owner and each member with a role, the note", () => {
    const html = shareDialog(share(), HOSTING_DETAIL, { org: "SaplingLearn", persons: PERSONS, dd: initialDropdownUi(), owner: true });
    expect(html).toContain(">Share Hosting providers<");
    expect(html).toContain('data-seg="pj-share-vis"');
    expect(html).toContain('id="pj-share-add"');
    expect(html).toContain("Add a person");
    expect(html).toContain(">Owner<");
    expect(html).toContain('id="pj-role-jose-gael-cruz-lopez"');
    expect(html).toContain(">Editor<");
    expect(html).toContain(">Viewer<");
    expect(html).toContain("Editors change instructions and Knowledge. Viewers read them and start their own chats. Chats stay with whoever started them.");
  });

  it("a private project's members are kept but cannot be changed, and it says so", () => {
    const html = shareDialog(share({ visibility: "private" }), HOSTING_DETAIL, { org: "SaplingLearn", persons: PERSONS, dd: initialDropdownUi(), owner: true });
    expect(html).toContain("Only the owner can open a private project.");
    expect(html).toMatch(/id="pj-share-add"[^>]*disabled/);
  });

  it("Delete: the spec's copy and Delete project", () => {
    const html = deleteDialog(PROJECT_HOSTING, false, null);
    expect(html).toContain(">Delete Hosting providers?<");
    expect(html).toContain(esc("Its 4 chats are deleted, including any shared with the project. Its 2 artifacts stay in Artifacts. The tickets, docs and PRs it pinned aren't touched."));
    expect(html).toContain(">Delete project<");
  });

  it("Delete counts what deleting takes: the server's `deleteCounts` (every chat, anyone's), else the reader's own", () => {
    const html = deleteDialog({ ...PROJECT_HOSTING, chats: 4, deleteCounts: { chats: 7, artifacts: 1 } }, false, null);
    expect(html).toContain(esc("Its 7 chats are deleted, including any shared with the project. Its 1 artifact stays in Artifacts."));
    expect(deletedProjectText("Hosting providers", 5)).toBe("Hosting providers deleted, with its 5 chats");
    expect(deletedProjectText("Hosting providers", 1)).toBe("Hosting providers deleted, with its 1 chat");
    expect(deletedProjectText("Hosting providers", 0)).toBe("Hosting providers deleted");
  });

  it("the app draws the open dialog at its root", () => {
    const s = initialState();
    s.view = "app"; s.screen = "project"; s.orgSlug = "saplinglearn";
    s.projects = { ...s.projects, slug: "hosting-providers", detail: { status: "ok", data: HOSTING_DETAIL }, dialog: { kind: "delete", slug: "hosting-providers", busy: false, error: null } };
    expect(render(s)).toContain('id="pj-delete"');
  });
});

// ── the controller's writes ──────────────────────────────────────────────────

type Call = { method: string; url: string; body: unknown };
describe("the controller — writes, the plan's sentence, Undo", () => {
  let calls: Call[] = [];
  let answer: (c: Call) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
  beforeEach(() => {
    calls = [];
    setApiOrg("saplinglearn");
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      const c = { method: (init.method ?? "GET").toUpperCase(), url, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null };
      calls.push(c);
      const a = answer(c);
      return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); setApiOrg(null); });

  function make(role: "owner" | "admin" | "member" = "owner") {
    const state: AppState = initialState();
    state.view = "app"; state.orgSlug = "saplinglearn";
    const flashes: { msg: string; action: unknown }[] = [];
    const mount = { querySelector: () => null } as unknown as HTMLElement;
    const ctl = createProjectsController({
      state, mount, rerender: () => undefined, rerenderSoon: () => undefined, unauth: () => undefined,
      flash: (msg, _ms, action) => { flashes.push({ msg, action: action ?? null }); },
      confirmOut: (then) => then(), role: () => role, prepareAsk: () => undefined, openThread: () => undefined,
      openHref: () => undefined, upgrade: () => undefined, threadsChanged: () => undefined,
    });
    return { state, ctl, flashes };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("New project posts to /projects and opens the new project's page", async () => {
    answer = (c) => (c.method === "POST" ? { status: 200, body: { project: { ...PROJECT_HOSTING, slug: "spring-rollout", name: "Spring rollout" } } } : { status: 200, body: c.url.endsWith("/projects") ? PROJECT_LIST : HOSTING_DETAIL });
    const { state, ctl, flashes } = make();
    ctl.act("projNew", null, null);
    ctl.act("projField", "name", "Spring rollout");
    ctl.act("projVis", "org", null);
    ctl.act("projSave", null, null);
    await settle(); await settle();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/o/saplinglearn/projects");
    expect(post.body).toMatchObject({ name: "Spring rollout", visibility: "org", icon: "server", color: "#525cc3" });
    expect(state.screen).toBe("project");
    expect(state.projects.slug).toBe("spring-rollout");
    expect(state.projects.dialog).toBeNull();
    expect(flashes.map((f) => f.msg)).toContain("Project created");
    expect(calls.some((c) => c.method === "GET" && c.url === "/api/o/saplinglearn/projects/spring-rollout")).toBe(true);
  });

  it("a 402 is the plan's one sentence, said to the owner", async () => {
    answer = () => ({ status: 402, body: { error: "plan_limit", limit: "projects", used: 2, cap: 2, plan: "free", status: "active", message: "Free includes 2 projects." } });
    const { state, ctl } = make();
    ctl.act("projNew", null, null);
    ctl.act("projField", "name", "Third");
    state.projects.list = { status: "ok", data: PROJECT_LIST };   // not at the cap as far as the screen knew
    ctl.act("projSave", null, null);
    await settle(); await settle();
    const d = state.projects.dialog;
    expect(d?.kind).toBe("edit");
    expect(d?.kind === "edit" && d.draft.error).toBe("Free includes 2 projects. Ask Trov to change your plan.");
  });

  it("Add to Knowledge posts the picked refs, then its toast's Undo removes them again", async () => {
    answer = () => ({ status: 200, body: HOSTING_DETAIL });
    const { state, ctl, flashes } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", detail: { status: "ok", data: HOSTING_DETAIL } };
    ctl.act("projAdd", null, null);
    ctl.act("projPinToggle", "ticket:90", "1");
    ctl.act("projPinToggle", "doc:hosting-connections", "1");
    ctl.act("projPinGo", null, null);
    await settle(); await settle();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/o/saplinglearn/projects/hosting-providers/pins");
    expect(post.body).toEqual({ refs: ["ticket:90", "doc:hosting-connections"] });
    const toast = flashes.at(-1)!;
    expect(toast.msg).toBe("Added 2 to Knowledge");
    expect(toast.action).toMatchObject({ label: "Undo", act: "projUndo" });
    ctl.act("projUndo", (toast.action as { arg: string }).arg, null);
    await settle(); await settle(); await settle();
    const dels = calls.filter((c) => c.method === "DELETE").map((c) => c.url);
    expect(dels).toEqual(["/api/o/saplinglearn/projects/hosting-providers/pins/ticket%3A90", "/api/o/saplinglearn/projects/hosting-providers/pins/doc%3Ahosting-connections"]);
  });

  it("Archive goes back to Projects with a toast whose Undo restores it", async () => {
    answer = (c) => ({ status: 200, body: c.url.endsWith("/archive") ? { ...PROJECT_HOSTING, archivedAt: "2026-11-05T22:40:00Z", archivedBy: "AndresL230" } : c.url.endsWith("/restore") ? PROJECT_HOSTING : PROJECT_LIST });
    const { state, ctl, flashes } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", list: { status: "ok", data: PROJECT_LIST }, detail: { status: "ok", data: HOSTING_DETAIL } };
    ctl.act("projArchive", "hosting-providers", null);
    await settle(); await settle();
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/o/saplinglearn/projects/hosting-providers/archive" });
    expect(state.screen).toBe("projects");
    const toast = flashes.at(-1)!;
    expect(toast.msg).toBe("Hosting providers archived");
    ctl.act("projUndo", (toast.action as { arg: string }).arg, null);
    await settle(); await settle();
    expect(calls.some((c) => c.method === "POST" && c.url === "/api/o/saplinglearn/projects/hosting-providers/restore")).toBe(true);
  });

  it("Share saves who can see it first, then the whole member list", async () => {
    answer = () => ({ status: 200, body: HOSTING_DETAIL });
    const { state, ctl } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", detail: { status: "ok", data: HOSTING_DETAIL } };
    ctl.act("projShare", "hosting-providers", null);
    ctl.act("projShareVis", "org", null);
    ctl.act("projShareAdd", null, "meilin");
    ctl.act("projShareRole", "jack-he", "remove");
    ctl.act("projShareSave", null, null);
    await settle(); await settle(); await settle();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "PATCH /api/o/saplinglearn/projects/hosting-providers",
      "PUT /api/o/saplinglearn/projects/hosting-providers/members",
    ]);
    expect(calls[0].body).toEqual({ visibility: "org" });
    expect(calls[1].body).toEqual({ members: [{ handle: "Jose-Gael-Cruz-Lopez", role: "editor" }, { handle: "meilin", role: "editor" }] });
  });

  it("a 403 says the server's own sentence; without one, the fixed one", () => {
    expect(projectErrorText(new OrgApiError(403, "forbidden", "Only the owner can change who can see this project.", null), "Couldn't save.")).toBe("Only the owner can change who can see this project.");
    expect(projectErrorText(new OrgApiError(403, "forbidden", null, null), "Couldn't save.")).toBe("Only the project's owner or an editor can change that.");
  });

  it("Delete's toast says how many chats went with it (the server's count)", async () => {
    answer = (c) => ({ status: 200, body: c.method === "DELETE" ? { ok: true, chats: 5, artifacts: 2 } : PROJECT_LIST });
    const { state, ctl, flashes } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", list: { status: "ok", data: PROJECT_LIST }, detail: { status: "ok", data: HOSTING_DETAIL } };
    ctl.act("projDelete", "hosting-providers", null);
    ctl.act("projDeleteGo", null, null);
    await settle(); await settle();
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/o/saplinglearn/projects/hosting-providers" });
    expect(flashes.map((f) => f.msg)).toContain("Hosting providers deleted, with its 5 chats");
  });

  it("Add to Knowledge past the project's pin room is refused in the dialog, and nothing is sent", async () => {
    const { state, ctl } = make();
    state.me = { orgs: [{ slug: "saplinglearn", name: "SaplingLearn", role: "owner", plan: "free" }] } as unknown as AppState["me"];
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", detail: { status: "ok", data: { ...HOSTING_DETAIL, pinLimit: { used: 19, cap: 20 } } } };
    ctl.act("projAdd", null, null);
    ctl.act("projPinToggle", "ticket:90", "1");
    ctl.act("projPinToggle", "doc:hosting-connections", "1");
    ctl.act("projPinGo", null, null);
    await settle();
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
    const d = state.projects.dialog;
    expect(d?.kind === "pin" && d.pick.error).toBe("This project has used 19 of the 20 pinned items Free includes. Pick 1 or fewer, or upgrade for more.");
    expect(pinRoomText({ used: 20, cap: 20 }, 1, false, "Free")).toBe("This project has used all 20 pinned items Free includes. Unpin one first, or ask an owner to upgrade.");
    expect(pinRoomText({ used: 19, cap: 20 }, 1, true, "Free")).toBeNull();
    expect(pinRoomText({ used: 500, cap: null }, 99, true, "Enterprise")).toBeNull();
  });

  it("a pick sent in chunks, one refused after others landed: the page shows what was added and the dialog says how many", async () => {
    const after = { ...HOSTING_DETAIL, pinLimit: { used: 35, cap: null } };
    let posts = 0;
    answer = (c) => (c.method === "POST" && ++posts > 1
      ? { status: 402, body: { error: "plan_limit", limit: "project_pins", used: 35, cap: 40, plan: "team", status: "active", message: "This project has reached the 40 pinned items per project this organization's Pro plan includes." } }
      : { status: 200, body: after });
    const { state, ctl } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", detail: { status: "ok", data: { ...HOSTING_DETAIL, pinLimit: { used: 10, cap: null } } } };
    ctl.act("projAdd", null, null);
    const refs = Array.from({ length: 30 }, (_, i) => `ticket:${200 + i}`);
    for (const r of refs) ctl.act("projPinToggle", r, "1");
    ctl.act("projPinGo", null, null);
    await settle(); await settle(); await settle();
    expect(calls.filter((c) => c.method === "POST").map((c) => (c.body as { refs: string[] }).refs.length)).toEqual([25, 5]);
    expect(state.projects.detail.data?.pinLimit.used).toBe(35);
    const d = state.projects.dialog;
    expect(d?.kind === "pin" && d.pick.error).toBe("Added 25 of 30. This project has reached the 40 pinned items per project this organization's Pro plan includes. Ask Trov to change your plan.");
    // What landed leaves the pick: Add again sends only the rest.
    expect(d?.kind === "pin" && d.pick.sel).toEqual(refs.slice(25));
  });

  it("files past Ask's rules are refused before anything is sent, in the project's words", () => {
    expect(uploadRefusalText(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}.txt`, size: 1 })))).toBe("Add at most 5 files at a time.");
    expect(uploadRefusalText([{ name: "huge.pdf", size: 11 * 1024 * 1024 }])).toBe("huge.pdf is too large. Files can be up to 10 MB.");
    expect(uploadRefusalText([{ name: "ok.pdf", size: 1024 }])).toBeNull();
  });

  it("Add to Knowledge opens on candidates before anything is typed (the project's candidates read), and a private draft among them warns once picked", async () => {
    const cands = { q: "", groups: [
      { type: "ticket", hits: [{ type: "ticket", id: "90", title: "Docs: how to connect each hosting provider", snippet: null, status: "submitted", by: null, at: null }] },
      { type: "artifact", hits: [{ type: "artifact", id: "railway-cold-start", title: "Railway cold start notes", snippet: null, status: "markdown", by: "AndresL230", at: null }] },
    ] };
    const priv = { ref: "artifact:railway-cold-start", type: "artifact", title: "Railway cold start notes", status: null, href: null, extra: { visibility: "private" } };
    answer = (c) => (c.url.includes("/candidates") ? { status: 200, body: { result: cands } } : c.url.endsWith("/ask/peek") ? { status: 200, body: { items: [priv] } } : { status: 200, body: HOSTING_DETAIL });
    const { state, ctl } = make();
    state.screen = "project";
    state.projects = { ...state.projects, slug: "hosting-providers", detail: { status: "ok", data: HOSTING_DETAIL } };
    ctl.act("projAdd", null, null);
    await settle(); await settle(); await settle();
    expect(calls[0]).toMatchObject({ method: "GET", url: "/api/o/saplinglearn/projects/hosting-providers/candidates?q=&type=all" });
    const d = state.projects.dialog!;
    expect(d.kind === "pin" && d.pick.status).toBe("ok");
    const html = pinDialog((d as { pick: PinPick }).pick, HOSTING_DETAIL);
    for (const w of [">Tickets<", ">Artifacts<", "Railway cold start notes"]) expect(html).toContain(w);
    ctl.act("projPinToggle", "artifact:railway-cold-start", "1");
    expect(pinDialog((state.projects.dialog as { pick: PinPick }).pick, HOSTING_DETAIL)).toContain(esc("Railway cold start notes is private to you."));
    // The type switch asks again, for that type.
    ctl.act("projPinType", "ticket", null);
    await settle();
    expect(calls.filter((c) => c.url.includes("/candidates")).at(-1)?.url).toBe("/api/o/saplinglearn/projects/hosting-providers/candidates?q=&type=ticket");
  });

  it("opening a project from a scrolled list starts at its top", () => {
    const state: AppState = initialState();
    state.view = "app"; state.orgSlug = "saplinglearn";
    const main = { scrollTo: vi.fn() };
    const mount = { querySelector: (sel: string) => (sel === "#cnpy-main" ? main : null) } as unknown as HTMLElement;
    const ctl = createProjectsController({
      state, mount, rerender: () => undefined, rerenderSoon: () => undefined, unauth: () => undefined, flash: () => undefined,
      confirmOut: (then) => then(), role: () => "owner", prepareAsk: () => undefined, openThread: () => undefined,
      openHref: () => undefined, upgrade: () => undefined, threadsChanged: () => undefined,
    });
    ctl.act("projOpen", "hosting-providers", null);
    expect(state.screen).toBe("project");
    expect(main.scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("a confirmation on its way out takes no clicks (the next one reaches the page), and no keys", () => {
    expect(css).toMatch(/\.cnpy-cmodal\[data-closing\], \.cnpy-cmodal\[data-closing\] \.cnpy-cmodal-box \{ pointer-events:none; \}/);
    expect(mainSrc).toContain(`Array.from(mount.querySelectorAll<HTMLElement>("[data-confirm-dialog]")).find((d) => !d.closest("[data-closing]"))`);
  });

  it("a project the person can't open is the one 404: the page says there is no project here", async () => {
    answer = () => ({ status: 404, body: { error: "not_found" } });
    const { state, ctl } = make();
    state.screen = "project";
    ctl.open("someone-elses");
    await settle(); await settle();
    expect(state.projects.detail).toEqual({ status: "ok", data: null });
  });
});

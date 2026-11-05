// Projects' guards, each proven on its own (docs/architecture/projects.md › Access; the spec
// docs/superpowers/specs/2026-11-05-projects.md › Who can do what). Each test below fails when ONE guard is removed:
//   · a private artifact in a project is its author's alone: the page's Artifacts, its `artifacts` count, the list's
//     counts (src/data/projects.ts `artifactsOf`, `artifactCounts`);
//   · a file uploaded into a private project is stored private, into a shared one the org's (src/tools/projects.ts
//     `uploadIntoProject`), and sharing the private project afterwards is `private_pin`;
//   · the defence-in-depth layers: `accessOf`'s `deleted_at`, the list's two filters (the SQL pre-filter `projectsFor`
//     and `readProjectList`'s `accessOf` filter, each alone), and moving a thread into a project (`setThreadProject`'s
//     owner clause, and the PATCH route's owner-only lookup) for someone the thread is merely shared with.
import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import { createPage } from "../src/tools/artifacts";
import { accessOf } from "../src/tools/projects";
import { projectsFor, type ProjectForRow } from "../src/data/projects";
import { setThreadProject } from "../src/data/ask";
import { app } from "../src/routes";
import { ProjectDetailSchema, ProjectListSchema } from "@shared/projects";
import { first } from "./helpers/db";
import { BASE, KEYED, ask, call, eventsOf, fakeModel, withAsk } from "./helpers/ask";
import { tenantCtx } from "./helpers/tenant";
import { EDITOR, OTHER, OWNER, P, VIEWER, cast, newProject, teamProject } from "./helpers/projects";

const final = (title = "Project answer") => `\n<trov-meta>{"title": "${title}", "followups": []}</trov-meta>`;
const threadIdOf = (events: { event: string; data: { id?: number } }[]) => eventsOf(events as never, "thread")[0].id as number;
const projectIdOf = async (slug: string) => (await first<{ id: number }>(env.DB, `SELECT id FROM projects WHERE slug = ?`, slug))!.id;

/** Ask one question with a scripted model that answers in words. */
async function askOnce(cookie: string, body: Record<string, unknown>, answer = `Done.${final()}`) {
  const model = fakeModel([[{ type: "text", text: answer }]]);
  return withAsk({ fetchImpl: model.fetchImpl }, () => ask(cookie, body));
}

/** `POST /projects/:project/files` (multipart: `call` sends JSON only). */
async function upload(cookie: string, slug: string, files: { name: string; type: string; body: string }[]) {
  const form = new FormData();
  for (const f of files) form.append("file", new File([f.body], f.name, { type: f.type }));
  const res = await app.request(`${P}/${slug}/files`, { method: "POST", headers: { cookie }, body: form }, KEYED);
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

describe("a private artifact in a project is its author's alone", () => {
  it("saved from a project thread, or put in the project directly: only its author sees it, its count or its words", async () => {
    const c = await cast();
    const p = await teamProject(c, { visibility: "org" }); // the editor and viewer are members; `other` opens it as a viewer
    const answer = "Zebra-quartz is the editor's private hosting summary.";
    const r = await askOnce(c.editor, { text: "Summarize the hosting state", projectId: p.slug }, `${answer}${final()}`);
    const id = threadIdOf(r.events);
    const saved = await call("POST", `${BASE}/ask/threads/${id}/save`, c.editor,
      { messageId: eventsOf(r.events, "done")[0].messageId as number, title: "Editor private summary", kind: "markdown", visibility: "private" });
    expect(saved.status).toBe(200);
    // It IS the project's, and private.
    expect(await first(env.DB, `SELECT visibility, project_id FROM artifact_pages WHERE slug = ?`, saved.json.slug))
      .toEqual({ visibility: "private", project_id: await projectIdOf(p.slug) });
    // The owner's own private artifact, put in the project directly.
    const mine = await createPage(await tenantCtx(OWNER), { title: "Owner secret plan", kind: "markdown", area: "data", repo: "", visibility: "private", content: "Basalt-heron owner notes" }, OWNER);
    await env.DB.prepare(`UPDATE artifact_pages SET project_id = ? WHERE id = ?`).bind(await projectIdOf(p.slug), mine.id).run();

    // Its author reads it on the page and in both counts.
    const asEditor = ProjectDetailSchema.parse((await call("GET", `${P}/${p.slug}`, c.editor)).json);
    expect(asEditor.artifacts.map((a) => a.slug)).toEqual([saved.json.slug]);
    expect(asEditor.project.artifacts).toBe(1);
    expect(ProjectListSchema.parse((await call("GET", P, c.editor)).json).projects.find((x) => x.slug === p.slug)?.artifacts).toBe(1);
    const asOwner = ProjectDetailSchema.parse((await call("GET", `${P}/${p.slug}`, c.owner)).json);
    expect(asOwner.artifacts.map((a) => a.slug)).toEqual([mine.slug]);
    expect(asOwner.project.artifacts).toBe(1);

    // Everyone else: not on the page, not in the count, not in the list's count, and not one word of it in the JSON.
    for (const [who, cookie] of [["viewer", c.viewer], ["other", c.other]] as const) {
      const res = await call("GET", `${P}/${p.slug}`, cookie);
      const d = ProjectDetailSchema.parse(res.json);
      expect(d.artifacts, who).toEqual([]);
      expect(d.project.artifacts, who).toBe(0);
      const list = await call("GET", P, cookie);
      expect(ProjectListSchema.parse(list.json).projects.find((x) => x.slug === p.slug)?.artifacts, who).toBe(0);
      for (const text of [res.text, list.text]) {
        for (const secret of [saved.json.slug, "Editor private summary", "Zebra-quartz", mine.slug, "Owner secret plan", "Basalt-heron"]) {
          expect(text, `${who}: ${secret}`).not.toContain(secret);
        }
      }
    }
    // And the owner never reads the editor's (only a count, `deleteCounts`, says what deleting would take).
    const ownerText = (await call("GET", `${P}/${p.slug}`, c.owner)).text;
    for (const secret of [saved.json.slug, "Editor private summary", "Zebra-quartz"]) expect(ownerText).not.toContain(secret);
  });
});

describe("uploading into a project keeps the project's visibility", () => {
  it("into a private project: stored private and pinned, and sharing the project afterwards is private_pin", async () => {
    const c = await cast();
    const priv = await newProject(c.owner, { name: "Mine", visibility: "private" });
    const r = await upload(c.owner, priv.slug, [{ name: "secret.md", type: "text/markdown", body: "# Mine alone" }]);
    expect(r.status).toBe(200);
    const d = ProjectDetailSchema.parse(r.json);
    expect(d.artifacts.map((a) => [a.title, a.visibility])).toEqual([["secret.md", "private"]]);
    expect(d.pins.map((x) => x.ref)).toEqual([`artifact:${d.artifacts[0].slug}`]);
    expect((await first<{ visibility: string }>(env.DB, `SELECT visibility FROM artifact_pages WHERE slug = ?`, d.artifacts[0].slug))!.visibility).toBe("private");
    for (const visibility of ["org", "members"] as const) {
      const share = await call("PATCH", `${P}/${priv.slug}`, c.owner, { visibility });
      expect([share.status, share.json.error], visibility).toEqual([400, "private_pin"]);
    }
    expect((await first<{ visibility: string }>(env.DB, `SELECT visibility FROM projects WHERE slug = ?`, priv.slug))!.visibility).toBe("private");
  });

  it("into a shared project: stored the org's and pinned, and every member reads it", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const r = await upload(c.editor, p.slug, [{ name: "shared.md", type: "text/markdown", body: "# For the team" }]);
    expect(r.status).toBe(200);
    const d = ProjectDetailSchema.parse(r.json);
    expect(d.artifacts.map((a) => [a.title, a.visibility, a.author])).toEqual([["shared.md", "org", EDITOR]]);
    expect(d.pins.map((x) => x.ref)).toEqual([`artifact:${d.artifacts[0].slug}`]);
    const asViewer = ProjectDetailSchema.parse((await call("GET", `${P}/${p.slug}`, c.viewer)).json);
    expect(asViewer.artifacts.map((a) => a.slug)).toEqual([d.artifacts[0].slug]);
    expect(asViewer.pins[0].view).toMatchObject({ ref: `artifact:${d.artifacts[0].slug}`, title: "shared.md" });
  });
});

describe("defence in depth: each layer alone", () => {
  it("accessOf: a deleted project opens for nobody, its owner included", async () => {
    const ctx = await tenantCtx(OWNER);
    const at = "2026-11-05T00:00:00.000Z";
    const row: ProjectForRow = {
      id: 1, slug: "gone", name: "Gone", description: "", icon: "server", color: "#525cc3", instructions: "", visibility: "org", owner: OWNER,
      archived_at: null, archived_by: null, deleted_at: null, created_at: at, updated_at: at, member_role: null,
    };
    expect(accessOf(ctx, row)).toBe("owner"); // the control: live, it is the owner's
    expect(accessOf(ctx, { ...row, deleted_at: at })).toBeNull();
    expect(accessOf(await tenantCtx(EDITOR), { ...row, deleted_at: at, member_role: "editor" })).toBeNull();
    expect(accessOf(await tenantCtx(VIEWER), { ...row, deleted_at: at })).toBeNull(); // an org project, as anyone
  });

  /** A private project with stale member rows (the editor and viewer were members before it went private), and a
   *  `members` project `other` is not in. */
  async function hiddenProjects() {
    const c = await cast();
    const priv = await teamProject(c, { name: "Went private" });
    expect((await call("PATCH", `${P}/${priv.slug}`, c.owner, { visibility: "private" })).status).toBe(200);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_members WHERE project_id = ?`, await projectIdOf(priv.slug)))!.n).toBe(2);
    const members = await teamProject(c, { name: "Members only" });
    return { c, priv, members };
  }

  it("projectsFor (the SQL pre-filter, alone): never a private project to a stale member, nor a members project to someone not in it", async () => {
    const { priv, members } = await hiddenProjects();
    const slugs = async (handle: string) => (await projectsFor(await tenantCtx(handle), handle)).map((r) => r.slug);
    expect(await slugs(OWNER)).toEqual(expect.arrayContaining([priv.slug, members.slug])); // the control
    expect(await slugs(EDITOR)).not.toContain(priv.slug);
    expect(await slugs(EDITOR)).toContain(members.slug);
    expect(await slugs(OTHER)).not.toContain(priv.slug);
    expect(await slugs(OTHER)).not.toContain(members.slug);
  });

  it("readProjectList's accessOf filter (alone, with the pre-filter widened): the same two never reach the list", async () => {
    // The filter only matters when the SQL pre-filter lets a row through, so `projectsFor` is widened here to the
    // given projects (their real rows, with the reader's member row). The setup file has already loaded src/ (it
    // imports src/mcp), so a hoisted vi.mock would never reach src/tools/projects.ts: the mock is scoped to this test
    // and a FRESH copy of the module is imported under it.
    const { c, priv, members } = await hiddenProjects();
    const ids = [await projectIdOf(priv.slug), await projectIdOf(members.slug)];
    vi.resetModules();
    vi.doMock("../src/data/projects", async (importOriginal) => {
      const real = await importOriginal<typeof import("../src/data/projects")>();
      return { ...real, projectsFor: (ctx: Parameters<typeof real.projectsFor>[0], handle: string) => real.projectsByIds(ctx, handle, ids) };
    });
    try {
      const { readProjectList } = await import("../src/tools/projects");
      const widened = await import("../src/data/projects");
      // A context from the fresh modules too (src/data/ keeps a context's D1 handle to its own module instance).
      const { tenantCtx: freshCtx } = await import("./helpers/tenant");
      // The control: widened, the pre-filter hands the stale member both projects.
      expect((await widened.projectsFor(await freshCtx(EDITOR), EDITOR)).map((r) => r.slug)).toEqual(expect.arrayContaining([priv.slug, members.slug]));
      const listed = async (handle: string) => {
        const l = ProjectListSchema.parse(await readProjectList(await freshCtx(handle)));
        return [...l.projects, ...l.archived].map((x) => x.slug);
      };
      expect(await listed(OWNER)).toEqual(expect.arrayContaining([priv.slug, members.slug])); // the control
      expect(await listed(EDITOR)).toEqual([members.slug]);
      expect(await listed(VIEWER)).toEqual([members.slug]);
      expect(await listed(OTHER)).toEqual([]);
    } finally {
      vi.doUnmock("../src/data/projects");
      vi.resetModules();
    }
    // The route (the real modules) agrees.
    expect(ProjectListSchema.parse((await call("GET", P, c.other)).json).projects.map((x) => x.slug)).toEqual([]);
  });

  it("setThreadProject: only the thread's owner moves it (the data layer's own clause)", async () => {
    const c = await cast();
    const p = await teamProject(c, { visibility: "org" });
    const pid = await projectIdOf(p.slug);
    const id = threadIdOf((await ask(c.owner, { text: "setup", command: "search" })).events);
    expect(await setThreadProject(await tenantCtx(VIEWER), VIEWER, id, pid)).toBe(false);
    expect((await first<{ project_id: number | null }>(env.DB, `SELECT project_id FROM chat_threads WHERE id = ?`, id))!.project_id).toBeNull();
    expect(await setThreadProject(await tenantCtx(OWNER), OWNER, id, pid)).toBe(true); // the control
    expect(await setThreadProject(await tenantCtx(VIEWER), VIEWER, id, null)).toBe(false);
    expect((await first<{ project_id: number | null }>(env.DB, `SELECT project_id FROM chat_threads WHERE id = ?`, id))!.project_id).toBe(pid);
  });

  it("PATCH { project } by someone the thread is SHARED with (the org, or by name) is the one 404, and nothing moves", async () => {
    const c = await cast();
    const p = await teamProject(c, { visibility: "org" });
    const pid = await projectIdOf(p.slug);
    const id = threadIdOf((await ask(c.owner, { text: "setup", command: "search" })).events);
    expect((await call("PATCH", `${BASE}/ask/threads/${id}`, c.owner, { shared: true, people: [{ handle: VIEWER, access: "continue" }] })).status).toBe(200);
    // They can read it…
    expect((await call("GET", `${BASE}/ask/threads/${id}`, c.viewer)).status).toBe(200);
    expect((await call("GET", `${BASE}/ask/threads/${id}`, c.other)).status).toBe(200);
    // …but not move it, into the project or (once the owner has) out of it.
    for (const cookie of [c.viewer, c.other]) {
      const r = await call("PATCH", `${BASE}/ask/threads/${id}`, cookie, { project: p.slug });
      expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
    }
    expect((await first<{ project_id: number | null }>(env.DB, `SELECT project_id FROM chat_threads WHERE id = ?`, id))!.project_id).toBeNull();
    expect((await call("PATCH", `${BASE}/ask/threads/${id}`, c.owner, { project: p.slug })).status).toBe(200);
    for (const cookie of [c.viewer, c.other]) {
      expect((await call("PATCH", `${BASE}/ask/threads/${id}`, cookie, { project: null })).status).toBe(404);
    }
    expect((await first<{ project_id: number | null }>(env.DB, `SELECT project_id FROM chat_threads WHERE id = ?`, id))!.project_id).toBe(pid);
  });
});

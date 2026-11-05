// Projects over HTTP (0086_projects; docs/architecture/projects.md; the spec docs/superpowers/specs/2026-11-05-projects.md):
// create / read / change, slugs, the access table row by row, private and archived projects, the plan limits, pins
// (hidden for a reader who can't see them; a private artifact refused on a shared project), the members list, and
// deleting (threads gone — a shared one too — artifacts kept with their project cleared, the slug reserved).
import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import { createPage } from "../src/tools/artifacts";
import { create_ticket } from "../src/tools/tickets";
import { ProjectDetailSchema, ProjectListSchema, ProjectSummarySchema } from "@shared/projects";
import { first } from "./helpers/db";
import { call, ask, eventsOf, BASE } from "./helpers/ask";
import { tenantCtx } from "./helpers/tenant";
import { addOrgRepo } from "./helpers/org-config";
import { EDITOR, OTHER, OWNER, P, VIEWER, cast, newProject, planOf, teamProject } from "./helpers/projects";

describe("creating, reading and changing a project", () => {
  it("creates one with a slug from its name; a clash adds -2, and a deleted project's slug stays reserved", async () => {
    const c = await cast();
    const a = ProjectSummarySchema.parse(await newProject(c.owner, { name: "Hosting providers", description: "  All hosts  ", instructions: "Be brief." }));
    expect(a).toMatchObject({ slug: "hosting-providers", name: "Hosting providers", description: "All hosts", owner: OWNER, access: "owner", visibility: "members",
      people: [OWNER], memberCount: 1, chats: 0, pins: 0, artifacts: 0, archivedAt: null });
    expect((await newProject(c.owner, { name: "Hosting  Providers!" })).slug).toBe("hosting-providers-2");
    expect((await call("DELETE", `${P}/hosting-providers-2`, c.owner)).status).toBe(200);
    // Deleted: not found, and its slug is still taken.
    expect((await call("GET", `${P}/hosting-providers-2`, c.owner)).json).toEqual({ error: "not_found" });
    expect((await newProject(c.owner, { name: "Hosting providers" })).slug).toBe("hosting-providers-3");
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM projects WHERE slug = 'hosting-providers-2' AND deleted_at IS NOT NULL`))!.n).toBe(1);
  });

  it("refuses a bad body with 400 invalid and writes nothing", async () => {
    const c = await cast();
    for (const body of [{ name: "", icon: "server", color: "#525cc3", visibility: "members" }, { name: "X", icon: "nope", color: "#525cc3", visibility: "members" },
      { name: "X", icon: "server", color: "#000000", visibility: "members" }, { name: "X", icon: "server", color: "#525cc3", visibility: "team" },
      { name: "X".repeat(61), icon: "server", color: "#525cc3", visibility: "members" }, { name: "X", icon: "server", color: "#525cc3", visibility: "members", instructions: "y".repeat(2001) },
      { name: "X", icon: "server", color: "#525cc3", visibility: "members", owner: "someone" }]) {
      const r = await call("POST", P, c.owner, body);
      expect([r.status, r.json.error], JSON.stringify(body)).toEqual([400, "invalid"]);
    }
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM projects`))!.n).toBe(0);
  });

  it("the list: live projects most recently updated first, the archived apart, ?q= by name and description, and the org's limit", async () => {
    const c = await cast();
    await newProject(c.owner, { name: "Alpha", description: "the first" });
    await newProject(c.owner, { name: "Beta", description: "exports" });
    await newProject(c.owner, { name: "Gamma" });
    await call("POST", `${P}/gamma/archive`, c.owner);
    const list = ProjectListSchema.parse((await call("GET", P, c.owner)).json);
    expect(list.projects.map((p) => p.slug)).toEqual(["beta", "alpha"]);
    expect(list.archived.map((p) => p.slug)).toEqual(["gamma"]);
    expect(list.archived[0]).toMatchObject({ archivedBy: OWNER });
    expect(list.limit).toEqual({ used: 2, cap: null }); // the seed org is Enterprise
    expect(ProjectListSchema.parse((await call("GET", `${P}?q=EXPORT`, c.owner)).json).projects.map((p) => p.slug)).toEqual(["beta"]);
    // Another member sees none of these (members-only).
    expect((await call("GET", P, c.other)).json.projects).toEqual([]);
  });

  it("PATCH changes details and instructions and answers the detail; the owner alone changes who can see it", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const r = await call("PATCH", `${P}/${p.slug}`, c.editor, { name: "Hosts", instructions: "Focus on blockers.", color: "#A84A68" });
    expect(r.status).toBe(200);
    const d = ProjectDetailSchema.parse(r.json);
    expect(d.project).toMatchObject({ name: "Hosts", instructions: "Focus on blockers.", color: "#a84a68", slug: p.slug, access: "editor", memberCount: 3, people: [OWNER, EDITOR, VIEWER] });
    expect(d.members).toEqual([{ handle: OWNER, role: "owner", addedAt: null }, { handle: EDITOR, role: "editor", addedAt: expect.any(String) }, { handle: VIEWER, role: "viewer", addedAt: expect.any(String) }]);
    expect(d.pinLimit).toEqual({ used: 0, cap: null });
    expect((await call("PATCH", `${P}/${p.slug}`, c.editor, { visibility: "org" })).json).toMatchObject({ error: "forbidden" });
    expect((await call("PATCH", `${P}/${p.slug}`, c.owner, { visibility: "org" })).json.project.visibility).toBe("org");
  });
});

describe("who can do what (the spec's table, row by row)", () => {
  type Who = keyof Awaited<ReturnType<typeof cast>>;
  const acts = {
    open: (s: string, ck: string) => call("GET", `${P}/${s}`, ck),
    edit: (s: string, ck: string) => call("PATCH", `${P}/${s}`, ck, { description: "changed" }),
    visibility: (s: string, ck: string) => call("PATCH", `${P}/${s}`, ck, { visibility: "members" }),
    members: (s: string, ck: string) => call("PUT", `${P}/${s}/members`, ck, { members: [{ handle: EDITOR, role: "editor" }, { handle: VIEWER, role: "viewer" }] }),
    pin: (s: string, ck: string) => call("POST", `${P}/${s}/pins`, ck, { refs: ["repo:SaplingLearn/sapling"] }),
    archive: (s: string, ck: string) => call("POST", `${P}/${s}/archive`, ck),
    restore: (s: string, ck: string) => call("POST", `${P}/${s}/restore`, ck),
    delete: (s: string, ck: string) => call("DELETE", `${P}/${s}`, ck),
  };
  type Act = keyof typeof acts;

  async function table(visibility: "members" | "org", expected: Record<Who, Record<Act, number>>) {
    const c = await cast();
    await addOrgRepo("SaplingLearn/sapling");
    for (const who of Object.keys(expected) as Who[]) {
      for (const act of Object.keys(acts) as Act[]) {
        // A fresh project for every act, so a delete or an archive never changes the next row.
        const p = await teamProject(c, { name: `${visibility} ${who} ${act}`, visibility });
        if (act === "restore") await call("POST", `${P}/${p.slug}/archive`, c.owner);
        const r = await acts[act](p.slug, c[who]);
        expect(r.status, `${who} ${act} on a ${visibility} project: ${r.text}`).toBe(expected[who][act]);
        if (r.status === 404) expect(r.json).toEqual({ error: "not_found" });
        if (r.status === 403) expect(r.json.error).toBe("forbidden");
      }
    }
  }
  const NONE = { open: 404, edit: 404, visibility: 404, members: 404, pin: 404, archive: 404, restore: 404, delete: 404 };
  const OWNS = { open: 200, edit: 200, visibility: 200, members: 200, pin: 200, archive: 200, restore: 200, delete: 200 };
  const EDITS = { open: 200, edit: 200, visibility: 403, members: 200, pin: 200, archive: 200, restore: 200, delete: 403 };
  const VIEWS = { open: 200, edit: 403, visibility: 403, members: 403, pin: 403, archive: 403, restore: 403, delete: 403 };
  const ADMINS = { open: 200, edit: 403, visibility: 403, members: 403, pin: 403, archive: 200, restore: 200, delete: 200 };

  it("a `members` project: owner, editor, viewer; an org admin and another member can't open it; another org's person neither", async () => {
    await table("members", { owner: OWNS, editor: EDITS, viewer: VIEWS, admin: NONE, other: NONE, stranger: NONE });
  });

  it("an `org` project: every member opens it as a viewer; an org admin also archives, restores and deletes it", async () => {
    await table("org", { owner: OWNS, editor: EDITS, viewer: VIEWS, admin: ADMINS, other: VIEWS, stranger: NONE });
  });

  it("another org's person gets the one 404 in their own org too, never the project", async () => {
    const c = await cast();
    const p = await newProject(c.owner, { visibility: "org" });
    const r = await call("GET", `/api/o/acme/projects/${p.slug}`, c.stranger);
    expect([r.status, r.json]).toEqual([404, { error: "not_found" }]);
    expect((await call("GET", "/api/o/acme/projects", c.stranger)).json.projects).toEqual([]);
  });

  it("a token is refused: projects are cookie only", async () => {
    const c = await cast();
    const r = await call("GET", P, c.owner, undefined, undefined, { authorization: "Bearer trov_mcp_x" });
    expect(r.status).toBe(403);
  });
});

describe("private and archived projects", () => {
  it("a private project is its owner's alone: members can't be added (400 invalid), and switching to private ignores the member rows", async () => {
    const c = await cast();
    const priv = await newProject(c.owner, { name: "Mine", visibility: "private" });
    const r = await call("PUT", `${P}/${priv.slug}/members`, c.owner, { members: [{ handle: EDITOR, role: "editor" }] });
    expect([r.status, r.json.error]).toEqual([400, "invalid"]);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_members`))!.n).toBe(0);
    for (const who of [c.editor, c.admin, c.other]) expect((await call("GET", `${P}/${priv.slug}`, who)).status).toBe(404);

    const p = await teamProject(c);
    expect((await call("PATCH", `${P}/${p.slug}`, c.owner, { visibility: "private" })).status).toBe(200);
    expect((await call("GET", `${P}/${p.slug}`, c.editor)).status).toBe(404);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_members`))!.n).toBe(2); // kept…
    const d = (await call("GET", `${P}/${p.slug}`, c.owner)).json;
    expect(d.members).toEqual([{ handle: OWNER, role: "owner", addedAt: null }]); // …and ignored
    expect(d.project.memberCount).toBe(1);
    await call("PATCH", `${P}/${p.slug}`, c.owner, { visibility: "members" });
    expect((await call("GET", `${P}/${p.slug}`, c.editor)).status).toBe(200); // back
  });

  it("an archived project is read-only: every write is 409 archived; restore brings it back", async () => {
    const c = await cast();
    const p = await teamProject(c);
    expect(ProjectSummarySchema.parse((await call("POST", `${P}/${p.slug}/archive`, c.editor)).json)).toMatchObject({ archivedBy: EDITOR });
    expect((await call("GET", `${P}/${p.slug}`, c.viewer)).status).toBe(200);
    for (const r of [
      await call("PATCH", `${P}/${p.slug}`, c.owner, { name: "Again" }),
      await call("PUT", `${P}/${p.slug}/members`, c.owner, { members: [] }),
      await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs: ["doc:anything"] }),
      await call("DELETE", `${P}/${p.slug}/pins/${encodeURIComponent("doc:anything")}`, c.owner),
    ]) expect([r.status, r.json.error]).toEqual([409, "archived"]);
    // A viewer is still forbidden first: they could not change it live either.
    expect((await call("PATCH", `${P}/${p.slug}`, c.viewer, { name: "x" })).json.error).toBe("forbidden");
    expect((await call("POST", `${P}/${p.slug}/restore`, c.owner)).json.archivedAt).toBeNull();
    expect((await call("PATCH", `${P}/${p.slug}`, c.owner, { name: "Again" })).status).toBe(200);
  });
});

describe("plan limits (402 plan_limit, the app's one body)", () => {
  it("Free: 2 live projects; an archived one doesn't count, and restoring past the cap is refused", async () => {
    const c = await cast();
    await planOf("free");
    await newProject(c.owner, { name: "One" });
    await newProject(c.owner, { name: "Two" });
    const r = await call("POST", P, c.owner, { name: "Three", icon: "server", color: "#525cc3", visibility: "members" });
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "projects", used: 2, cap: 2, plan: "free" });
    expect((await call("GET", P, c.owner)).json.limit).toEqual({ used: 2, cap: 2 });
    await call("POST", `${P}/one/archive`, c.owner);
    await newProject(c.owner, { name: "Three" });
    const back = await call("POST", `${P}/one/restore`, c.owner);
    expect([back.status, back.json.limit]).toEqual([402, "projects"]);
  });

  it("Free: 20 pins a project; the 21st is refused and nothing is pinned", async () => {
    const c = await cast();
    await planOf("free");
    const p = await newProject(c.owner);
    const ctx = await tenantCtx(OWNER);
    const refs: string[] = [];
    for (let i = 0; i < 21; i++) refs.push(`ticket:${await create_ticket(ctx, { title: `T${i}`, body: "", category: "bug", priority: "normal", assignees: [] }, OWNER)}`);
    expect((await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs: refs.slice(0, 20) })).json.pinLimit).toEqual({ used: 20, cap: 20 });
    // Pinning again what is already pinned adds nothing (and so is not refused).
    expect((await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs: refs.slice(0, 2) })).status).toBe(200);
    const r = await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs: [refs[20]] });
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ error: "plan_limit", limit: "project_pins", used: 20, cap: 20 });
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_pins`))!.n).toBe(20);
  });
});

describe("pins", () => {
  it("a pin is drawn through Ask's RefView for the reader; one they can't see is { ref, hidden: true }", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const ctx = await tenantCtx(OWNER);
    const n = await create_ticket(ctx, { title: "Connect Netlify", body: "", category: "bug", priority: "normal", assignees: [] }, OWNER);
    const r = await call("POST", `${P}/${p.slug}/pins`, c.editor, { refs: [`ticket:${n}`] });
    expect(r.status).toBe(200);
    // The editor's own private artifact can't be pinned on a members project…
    const ectx = await tenantCtx(EDITOR);
    const secret = await createPage(ectx, { title: "Editor notes", kind: "markdown", area: "data", repo: "", visibility: "private", content: "x" }, EDITOR);
    const refused = await call("POST", `${P}/${p.slug}/pins`, c.editor, { refs: [`artifact:${secret.slug}`] });
    expect([refused.status, refused.json.error]).toEqual([400, "private_pin"]);
    // …but published, it is; then made private again, the viewer sees it hidden while the editor still sees it.
    const pub = await createPage(ectx, { title: "Editor plan", kind: "markdown", area: "data", repo: "", visibility: "org", content: "x" }, EDITOR);
    await call("POST", `${P}/${p.slug}/pins`, c.editor, { refs: [`artifact:${pub.slug}`] });
    await env.DB.prepare(`UPDATE artifact_pages SET visibility = 'private' WHERE slug = ?`).bind(pub.slug).run();
    const viewer = ProjectDetailSchema.parse((await call("GET", `${P}/${p.slug}`, c.viewer)).json);
    expect(viewer.pins.map((x) => x.view)).toEqual([{ ref: `artifact:${pub.slug}`, hidden: true }, expect.objectContaining({ ref: `ticket:${n}`, type: "ticket", title: "Connect Netlify" })]);
    const editor = ProjectDetailSchema.parse((await call("GET", `${P}/${p.slug}`, c.editor)).json);
    expect(editor.pins[0].view).toMatchObject({ ref: `artifact:${pub.slug}`, title: "Editor plan" });
    expect(editor.pins[0]).toMatchObject({ addedBy: EDITOR });
  });

  it("refuses a ref of a type a project can't pin, or one that names nothing the person can see — nothing is pinned", async () => {
    const c = await cast();
    const p = await newProject(c.owner);
    for (const refs of [["person:pj-editor"], ["feed:1"], ["ticket:99999"], ["not a ref"], ["doc:missing", "repo:SaplingLearn/sapling"]]) {
      const r = await call("POST", `${P}/${p.slug}/pins`, c.owner, { refs });
      expect([r.status, r.json.error], JSON.stringify(refs)).toEqual([400, "invalid"]);
    }
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_pins`))!.n).toBe(0);
  });

  it("a ref with a slash is removed by its URL-encoded form; sharing a project that pins a private artifact is refused", async () => {
    const c = await cast();
    await addOrgRepo("SaplingLearn/sapling");
    const priv = await newProject(c.owner, { visibility: "private" });
    const secret = await createPage(await tenantCtx(OWNER), { title: "Mine", kind: "markdown", area: "data", repo: "", visibility: "private", content: "x" }, OWNER);
    expect((await call("POST", `${P}/${priv.slug}/pins`, c.owner, { refs: [`artifact:${secret.slug}`, "repo:SaplingLearn/sapling"] })).json.pins).toHaveLength(2);
    const share = await call("PATCH", `${P}/${priv.slug}`, c.owner, { visibility: "org" });
    expect([share.status, share.json.error]).toEqual([400, "private_pin"]);
    const gone = await call("DELETE", `${P}/${priv.slug}/pins/${encodeURIComponent("repo:SaplingLearn/sapling")}`, c.owner);
    expect(gone.json.pins.map((x: { ref: string }) => x.ref)).toEqual([`artifact:${secret.slug}`]);
  });
});

describe("the members list (PUT, the whole list)", () => {
  it("refuses a non-member, the owner or a duplicate with 400 invalid, and writes nothing", async () => {
    const c = await cast();
    const p = await teamProject(c);
    for (const members of [
      [{ handle: "nobody-here", role: "editor" }],
      [{ handle: OWNER, role: "editor" }],
      [{ handle: EDITOR, role: "editor" }, { handle: "PJ-EDITOR", role: "viewer" }],
      [{ handle: EDITOR, role: "owner" }],
    ]) {
      const r = await call("PUT", `${P}/${p.slug}/members`, c.owner, { members });
      expect([r.status, r.json.error], JSON.stringify(members)).toEqual([400, "invalid"]);
    }
    const rows = (await env.DB.prepare(`SELECT handle, role FROM project_members ORDER BY handle`).all()).results;
    expect(rows).toEqual([{ handle: EDITOR, role: "editor" }, { handle: VIEWER, role: "viewer" }]);
  });

  it("replaces the list: a person kept keeps when they were added; the handle is stored in the member's own spelling", async () => {
    const c = await cast();
    const p = await teamProject(c);
    const before = (await first<{ added_at: string }>(env.DB, `SELECT added_at FROM project_members WHERE handle = ?`, EDITOR))!.added_at;
    const r = await call("PUT", `${P}/${p.slug}/members`, c.editor, { members: [{ handle: "PJ-EDITOR", role: "viewer" }, { handle: OTHER, role: "editor" }] });
    expect(r.status).toBe(200);
    expect(r.json.members.map((m: { handle: string; role: string }) => [m.handle, m.role])).toEqual([[OWNER, "owner"], [EDITOR, "viewer"], [OTHER, "editor"]]);
    expect((await first<{ added_at: string }>(env.DB, `SELECT added_at FROM project_members WHERE handle = ?`, EDITOR))!.added_at).toBe(before);
    // The editor, now a viewer, can't change it any more; the viewer who was taken off can't open it.
    expect((await call("PATCH", `${P}/${p.slug}`, c.editor, { name: "x" })).status).toBe(403);
    expect((await call("GET", `${P}/${p.slug}`, c.viewer)).status).toBe(404);
  });
});

describe("deleting a project", () => {
  it("deletes its threads (a shared one too), keeps its artifacts with project_id cleared, and reserves its slug", async () => {
    const c = await cast();
    const p = await teamProject(c);
    // The owner's thread, shared with the org; the viewer's own thread in it.
    const own = eventsOf((await ask(c.owner, { text: "setup", command: "search", projectId: p.slug })).events, "thread")[0].id as number;
    await call("PATCH", `${BASE}/ask/threads/${own}`, c.owner, { shared: true });
    const theirs = eventsOf((await ask(c.viewer, { text: "mine", command: "search", projectId: p.slug })).events, "thread")[0].id as number;
    const art = await createPage(await tenantCtx(OWNER), { title: "Kept", kind: "markdown", area: "data", repo: "", visibility: "org", content: "x" }, OWNER);
    await env.DB.prepare(`UPDATE artifact_pages SET project_id = (SELECT id FROM projects WHERE slug = ?) WHERE id = ?`).bind(p.slug, art.id).run();
    expect((await call("GET", `${P}/${p.slug}`, c.owner)).json.project).toMatchObject({ chats: 1, artifacts: 1 });

    // The editor may not; the owner may.
    expect((await call("DELETE", `${P}/${p.slug}`, c.editor)).status).toBe(403);
    const r = await call("DELETE", `${P}/${p.slug}`, c.owner);
    expect(r.json).toEqual({ ok: true, chats: 2, artifacts: 1 });
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM chat_threads WHERE id IN (?, ?)`, own, theirs))!.n).toBe(0);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id IN (?, ?)`, own, theirs))!.n).toBe(0);
    expect(await first(env.DB, `SELECT project_id, deleted_at FROM artifact_pages WHERE id = ?`, art.id)).toEqual({ project_id: null, deleted_at: null });
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_members`))!.n).toBe(0);
    expect((await first<{ n: number }>(env.DB, `SELECT COUNT(*) AS n FROM project_pins`))!.n).toBe(0);
    for (const who of [c.owner, c.editor]) expect((await call("GET", `${P}/${p.slug}`, who)).json).toEqual({ error: "not_found" });
    expect((await newProject(c.owner)).slug).toBe(`${p.slug}-2`);
    // The org's admin, who could open an org project, may delete it too.
    const orgProject = await newProject(c.owner, { name: "Open", visibility: "org" });
    expect((await call("DELETE", `${P}/${orgProject.slug}`, c.admin)).status).toBe(200);
  });
});

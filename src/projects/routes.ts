// Projects over HTTP (0086_projects; docs/architecture/projects.md) — mounted at `/api/o/:slug` (`PROJECT_ROUTES`,
// shared/projects-core.ts), COOKIE ONLY: a request carrying an Authorization header is refused (CLAUDE.md invariant 8),
// and none of this is an MCP tool (projects' MCP tools are a later phase). `tenantGate` has resolved `c.var.ctx`.
//
//   GET    /projects                      ProjectList (`?q=` filters by name and description)
//   POST   /projects                      ProjectCreateBody → { project: ProjectSummary }
//   GET    /projects/:project             ProjectDetail
//   PATCH  /projects/:project             ProjectPatchBody → ProjectDetail
//   DELETE /projects/:project             { ok: true, chats, artifacts } (owner, or an org admin who can open it)
//   POST   /projects/:project/archive     ProjectSummary;  …/restore the same
//   PUT    /projects/:project/members     ProjectMembersBody → ProjectDetail
//   POST   /projects/:project/pins        ProjectPinsBody → ProjectDetail
//   DELETE /projects/:project/pins/:ref   ProjectDetail
//   POST   /projects/:project/files       multipart (Ask's attachment rules) → ProjectDetail
//   GET    /projects/:project/candidates  `?q=&type=` → { result: QuickSearchResult } (what Add to <project> offers)
//
// The rules (who may open and change what, the refusals' order) are src/tools/projects.ts's; a project the person
// can't open is the ONE `404 { error: "not_found" }`. A plan refusal goes to the app's one 402 handler.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { AppEnv } from "../auth/principal";
import { platform } from "../data/context";
import { PlanFeatureError, PlanLimitError } from "../plans/state";
import { ProjectCreateBodySchema, ProjectMembersBodySchema, ProjectPatchBodySchema, ProjectPinsBodySchema, PROJECT_ROUTES } from "@shared/projects";
import {
  ProjectRefusal, archiveProject, createProject, patchProject, pinRefs, projectForPinning, projectToDelete, putMembers, readProjectDetail, readProjectList, readSummary,
  restoreProject, unpinRef, uploadIntoProject, type PinViews,
} from "../tools/projects";
import { deleteProject } from "../deletion/projects";
import { resolveViews } from "../ai/ask/refs";
import { AttachError, checkFiles } from "../ai/ask/attachments";
import { ArtifactError, ARTIFACT_ERROR_STATUS } from "../tools/artifacts";
import { ASK_ATTACH_FILES_MAX } from "@shared/ai-ask-core";
import { quickRecent, quickSearch } from "../tools/quick-search";
import { QUICK_MIN_CHARS, type QuickType } from "@shared/quick-search";
import { projectChats } from "../ai/ask/routes";

type C = Context<AppEnv>;

const cookieOnly: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header("authorization")
    ? c.json({ error: "forbidden", message: "a project is a signed-in person's to change, never a token's" }, 403)
    : next();

/** Ask's own ref views (permission-checked for the reader) draw every pin. */
const views: PinViews = (ctx, viewer, refs) => resolveViews(ctx, viewer, refs, new Date());

/** Run a route; map each refusal to its status. A plan refusal is rethrown for the app's one 402 handler. */
async function guard(c: C, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof PlanLimitError || e instanceof PlanFeatureError) throw e;
    if (e instanceof ProjectRefusal) {
      if (e.code === "not_found") return c.json({ error: "not_found" }, 404);
      // A project's 403 is about the PROJECT role (owner, editor, viewer), not the org's: it carries its own hint, so
      // the API's generic one ("needs a role… (admin or owner)… Ask an admin") never answers it (src/error-hints.ts).
      return c.json({ error: e.code, message: e.message, ...(e.code === "forbidden" ? { hint: `${e.message} Nothing was changed.` } : {}) }, e.status);
    }
    if (e instanceof AttachError) return c.json({ error: e.code, message: e.message }, e.status); // Ask's own codes
    // An upload's artifact refused by the artifacts store's own writer (`createPage`: its title, size and type checks).
    if (e instanceof ArtifactError) return c.json({ error: e.code, message: e.message }, ARTIFACT_ERROR_STATUS[e.code]);
    throw e;
  }
}

/** A read that backs a screen: a failure is a 503 `{ error }`, never a 500 (invariant 7). */
async function read(c: C, what: string, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await guard(c, fn);
  } catch (e) {
    console.error("projects read", e instanceof Error ? e.name : "error");
    return c.json({ error: `Couldn't read ${what}` }, 503);
  }
}

const jsonBody = async (c: C): Promise<unknown> => c.req.json().catch(() => null);
const slugOf = (c: C): string => c.req.param("project") ?? "";
const detail = (c: C, slug: string) => readProjectDetail(c.var.ctx, slug, views, projectChats);

export const projectsApp = new Hono<AppEnv>();
projectsApp.use(PROJECT_ROUTES.list, cookieOnly);
projectsApp.use(`${PROJECT_ROUTES.list}/*`, cookieOnly);

projectsApp.get(PROJECT_ROUTES.list, (c) => read(c, "the projects", async () =>
  c.json(await readProjectList(c.var.ctx, (c.req.query("q") ?? "").slice(0, 200)))));

projectsApp.post(PROJECT_ROUTES.list, (c) => guard(c, async () => {
  const parsed = ProjectCreateBodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  const slug = await createProject(c.var.ctx, parsed.data);
  return c.json({ project: await readSummary(c.var.ctx, slug) });
}));

projectsApp.get(PROJECT_ROUTES.one, (c) => read(c, "this project", async () => c.json(await detail(c, slugOf(c)))));

projectsApp.patch(PROJECT_ROUTES.one, (c) => guard(c, async () => {
  const parsed = ProjectPatchBodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  await patchProject(c.var.ctx, slugOf(c), parsed.data);
  return c.json(await detail(c, slugOf(c)));
}));

projectsApp.delete(PROJECT_ROUTES.one, (c) => guard(c, async () => {
  const row = await projectToDelete(c.var.ctx, slugOf(c));
  const done = await deleteProject(c.var.ctx, platform(c.env, c.var.ctx.userId), c.env.ARTIFACTS_BUCKET, row.id);
  return c.json({ ok: true, ...done });
}));

projectsApp.post(PROJECT_ROUTES.archive, (c) => guard(c, async () => {
  await archiveProject(c.var.ctx, slugOf(c));
  return c.json(await readSummary(c.var.ctx, slugOf(c)));
}));

projectsApp.post(PROJECT_ROUTES.restore, (c) => guard(c, async () => {
  await restoreProject(c.var.ctx, slugOf(c));
  return c.json(await readSummary(c.var.ctx, slugOf(c)));
}));

projectsApp.put(PROJECT_ROUTES.members, (c) => guard(c, async () => {
  const parsed = ProjectMembersBodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  await putMembers(c.var.ctx, slugOf(c), parsed.data);
  return c.json(await detail(c, slugOf(c)));
}));

projectsApp.post(PROJECT_ROUTES.pins, (c) => guard(c, async () => {
  const parsed = ProjectPinsBodySchema.safeParse(await jsonBody(c));
  if (!parsed.success) return c.json({ error: "invalid", issues: parsed.error.issues }, 400);
  await pinRefs(c.var.ctx, slugOf(c), parsed.data.refs, views);
  return c.json(await detail(c, slugOf(c)));
}));

projectsApp.delete(PROJECT_ROUTES.pin, (c) => guard(c, async () => {
  // Hono decoded the path once; a client that encoded twice is decoded again.
  const raw = c.req.param("ref") ?? "";
  let ref = raw;
  try { ref = decodeURIComponent(raw); } catch { /* already decoded */ }
  await unpinRef(c.var.ctx, slugOf(c), ref);
  return c.json(await detail(c, slugOf(c)));
}));

/** The quick search's groups a project can pin (pull requests are not in it: the dialog offers the ones Trov shows). */
const CANDIDATE_TYPES = ["ticket", "sprint", "doc", "decision", "artifact"] as const satisfies readonly QuickType[];

projectsApp.get(PROJECT_ROUTES.candidates, (c) => read(c, "what to pin", async () => {
  await projectForPinning(c.var.ctx, slugOf(c));
  const type = c.req.query("type") ?? "all";
  const types: QuickType[] = (CANDIDATE_TYPES as readonly string[]).includes(type) ? [type as QuickType] : type === "all" ? [...CANDIDATE_TYPES] : [];
  const q = (c.req.query("q") ?? "").slice(0, 200).trim();
  const opts = { types, limit: types.length === 1 ? 8 : 4, artifactDrafts: true };
  c.header("cache-control", "private, no-store");
  if (!types.length) return c.json({ result: { q, groups: [] } });
  // Under the quick search's 2 characters, what changed most recently (the quick search would answer nothing).
  const me = c.var.ctx.userId;
  return c.json({ result: q.length >= QUICK_MIN_CHARS ? await quickSearch(c.var.ctx, q, me, opts) : await quickRecent(c.var.ctx, me, opts) });
}));

projectsApp.post(PROJECT_ROUTES.upload, (c) => guard(c, async () => {
  let form: FormData;
  try { form = await c.req.raw.formData(); } catch { return c.json({ error: "invalid", message: "Send multipart/form-data with file fields." }, 400); }
  const files: { name: string; type: string; bytes: Uint8Array }[] = [];
  for (const v of form.getAll("file") as unknown as (string | File)[]) {
    if (typeof v === "string") continue;
    files.push({ name: v.name || "file", type: v.type || "application/octet-stream", bytes: new Uint8Array(await v.arrayBuffer()) });
  }
  // Ask's attachment rules, checked whole before anything is stored: ≤ 5 files, 10 MB each, images / PDFs / text. The
  // count is said here in the project's words (Ask's own sentence is "per message").
  if (files.length > ASK_ATTACH_FILES_MAX) return c.json({ error: "invalid", message: `Add at most ${ASK_ATTACH_FILES_MAX} files at a time.` }, 400);
  const checked = checkFiles(files);
  await uploadIntoProject(c.var.ctx, c.env.ARTIFACTS_BUCKET, slugOf(c), checked.map((x) => ({ ...x.f, kind: x.kind })));
  return c.json(await detail(c, slugOf(c)));
}));
